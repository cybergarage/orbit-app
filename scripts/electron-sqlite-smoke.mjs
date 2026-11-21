import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { packager } from "@electron/packager";

const root = path.resolve(import.meta.dirname, "..");
const mode = process.argv[2] ?? "probe";
assert.ok(["probe", "host-proof", "host-package"].includes(mode));
const probe = mode === "probe";
const electronVersion = "44.5.1";
const sqliteVersion = "12.11.1";
const headersHash =
	"ba56f6db1f43baeda19c82d3f72beeb00e20c8ba87e787a763db60f44d212977";
const headersName = `node-v${electronVersion}-headers.tar.gz`;
const json = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const sha256 = async (file) =>
	createHash("sha256")
		.update(await fs.readFile(file))
		.digest("hex");
if (process.platform !== "darwin" || process.arch !== "arm64")
	throw new Error("This packaged SQLite proof requires native macOS arm64");
const npm = process.env.npm_execpath;
assert.ok(npm && path.isAbsolute(npm), "Run npm run test:electron-sqlite");
const npmRequire = createRequire(npm);
const gyp = npmRequire.resolve("node-gyp/bin/node-gyp.js");
assert.equal(
	npmRequire("node-gyp/package.json").version,
	"12.4.0",
	"Use the pinned native build toolchain: Node 26.10.0 / npm 11.19.1 (node-gyp 12.4.0)",
);
assert.equal(process.versions.node, "26.10.0");
assert.equal(
	(
		await json(
			path.resolve(path.dirname(await fs.realpath(npm)), "../package.json"),
		)
	).version,
	"11.19.1",
);
const lock = await json(path.join(root, "package-lock.json"));
assert.equal(lock.packages["node_modules/electron"].version, electronVersion);
assert.equal(
	lock.packages["node_modules/better-sqlite3"].version,
	sqliteVersion,
);

function run(exe, args, cwd, env = process.env, timeout = 120_000) {
	const result = spawnSync(exe, args, {
		cwd,
		env,
		encoding: "utf8",
		killSignal: "SIGKILL",
		timeout,
		maxBuffer: 2 * 1024 * 1024,
	});
	if (result.error)
		throw new Error(
			`${result.error.message}\n${result.stdout}\n${result.stderr}`,
			{ cause: result.error },
		);
	if (result.status !== 0)
		throw new Error(
			`${path.basename(exe)} failed (${result.signal ?? result.status}):\n${result.stdout}\n${result.stderr}`,
		);
	return result.stdout;
}

const scratch = await fs.mkdtemp(
	path.join(await fs.realpath(os.tmpdir()), "orbit-electron-sqlite-"),
);
try {
	const appRoot = path.join(scratch, "input");
	const packageRoot = path.join(appRoot, "worker/packages");
	await fs.mkdir(packageRoot, { recursive: true, mode: 0o700 });
	const manifest = await json(path.join(root, "package.json"));
	const packages = path.join(root, "worker/packages");
	const core = await json(path.join(packages, "core-artifact.json"));
	assert.match(core.file, /^cybergarage-orbit-[0-9.a-z-]+\.tgz$/);
	assert.equal(
		manifest.dependencies["@cybergarage/orbit"],
		`file:worker/packages/${core.file}`,
	);
	assert.equal(
		await sha256(path.join(packages, core.file)),
		core.sha256,
		"Verify the existing pinned Core build input",
	);
	await fs.copyFile(
		path.join(packages, core.file),
		path.join(packageRoot, core.file),
	);
	await fs.copyFile(
		path.join(root, "package-lock.json"),
		path.join(appRoot, "package-lock.json"),
	);
	await fs.writeFile(
		path.join(appRoot, "package.json"),
		JSON.stringify({
			...manifest,
			main: probe ? "probe.cjs" : manifest.main,
		}),
	);
	if (probe) {
		await fs.copyFile(
			path.join(root, "scripts/electron-sqlite-probe-main.cjs"),
			path.join(appRoot, "probe.cjs"),
		);
	} else {
		await fs.cp(path.join(root, "dist"), path.join(appRoot, "dist"), {
			recursive: true,
		});
	}
	run(
		process.execPath,
		[npm, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
		appRoot,
	);
	const native = path.join(appRoot, "node_modules/better-sqlite3");
	assert.equal(
		(await json(path.join(native, "package.json"))).version,
		sqliteVersion,
	);
	const tarball = path.join(scratch, headersName);
	run(
		"/usr/bin/curl",
		[
			"--fail",
			"--silent",
			"--show-error",
			"--location",
			"--max-time",
			"55",
			"--output",
			tarball,
			`https://electronjs.org/headers/v${electronVersion}/${headersName}`,
		],
		scratch,
	);
	assert.equal(
		await sha256(tarball),
		headersHash,
		"Electron header SHA-256 mismatch",
	);
	const devdir = path.join(scratch, "gyp");
	run(
		process.execPath,
		[
			gyp,
			"install",
			`--target=${electronVersion}`,
			`--tarball=${tarball}`,
			`--devdir=${devdir}`,
		],
		scratch,
	);
	run(
		process.execPath,
		[
			gyp,
			"rebuild",
			"--release",
			"--arch=arm64",
			`--target=${electronVersion}`,
			`--nodedir=${path.join(devdir, electronVersion)}`,
			"--jobs=2",
		],
		native,
		process.env,
		240_000,
	);
	const out =
		mode === "host-package"
			? path.join(root, "release/host-agent")
			: path.join(scratch, "packaged");
	const name = probe ? "OrbitSQLiteProbe" : "Orbit App";
	const appBundleId = probe
		? "org.cybergarage.orbit-app.sqliteprobe"
		: "org.cybergarage.orbit-app";
	const binaries = await packager({
		dir: appRoot,
		out,
		name,
		appBundleId,
		overwrite: mode === "host-package",
		electronVersion,
		platform: "darwin",
		arch: "arm64",
		asar: { unpack: "**/*.node" },
		// The stage was installed with npm ci --omit=dev. Do not walk omitted dev packages.
		prune: false,
		ignore: [/^\/worker(\/|$)/],
		...(probe ? { extendInfo: { LSUIElement: true } } : {}),
	});
	assert.equal(binaries.length, 1);
	const bundle = path.join(binaries[0], `${name}.app`);
	const emitted = path.join(bundle, "Contents/MacOS", name);
	if (!probe) {
		if (mode === "host-package") console.log(bundle);
		else {
			const { verifyPackagedCatalog } = await import(
				"./host-catalog-app-smoke.mjs"
			);
			await verifyPackagedCatalog(bundle, emitted, scratch);
		}
	} else {
		const data = path.join(scratch, "synthetic");
		await fs.mkdir(path.join(data, "profile"), {
			recursive: true,
			mode: 0o700,
		});
		const env = { ...process.env, ORBIT_SQLITE_PROBE_ROOT: data };
		delete env.ELECTRON_RUN_AS_NODE;
		delete env.NODE_OPTIONS;
		const output = run(
			emitted,
			["--enable-logging=stderr"],
			scratch,
			env,
			35_000,
		);
		assert.match(output, /ABI 149: Core SQLite opened, wrote and reopened/);
		process.stdout.write(output);
	}
} finally {
	await fs.rm(scratch, { recursive: true, force: true });
}
