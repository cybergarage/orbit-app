import os from "node:os";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const root = path.resolve(import.meta.dirname, "..");
const verifyOnly = process.argv.includes("--verify-source");
const argument = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const core = path.resolve(argument ?? path.join(root, "../orbit"));
const metadataPath = path.join(root, "worker/packages/core-artifact.json");
const pinned = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
if (
	core === root ||
	!fs.existsSync(path.join(core, "src/core/projects/source-lease.ts"))
)
	throw new Error("Select the separate Project knowledge Core checkout");
const revision = spawnSync("git", ["rev-parse", "HEAD"], {
	cwd: core,
	encoding: "utf8",
});
const changes = spawnSync("git", ["status", "--porcelain"], {
	cwd: core,
	encoding: "utf8",
});
if (
	!/^[a-f0-9]{40}$/.test(pinned.source?.commit ?? "") ||
	revision.status !== 0 ||
	revision.stdout.trim() !== pinned.source.commit ||
	changes.status !== 0 ||
	changes.stdout.trim()
)
	throw new Error(
		"Use a clean Core checkout at the exact source commit in worker/packages/core-artifact.json",
	);
if (verifyOnly) {
	const artifact = path.join(root, "worker/packages", pinned.file);
	const actual = createHash("sha256")
		.update(fs.readFileSync(artifact))
		.digest("hex");
	if (actual !== pinned.sha256)
		throw new Error("Vendored Core artifact hash mismatch");
	process.stdout.write(`Verified Core source ${pinned.source.commit}\n`);
	process.exit(0);
}
const run = (cwd, args) => {
	const r = spawnSync("npm", args, { cwd, stdio: "inherit" });
	if (r.status !== 0) throw new Error(`npm ${args[0]} failed`);
};
run(core, ["run", "build"]);
run(core, ["exec", "--", "oclif", "manifest"]);
fs.mkdirSync(path.join(root, "worker/packages"), { recursive: true });
run(core, [
	"pack",
	"--ignore-scripts",
	"--cache",
	path.join(os.tmpdir(), "orbit-package-cache"),
	"--pack-destination",
	path.join(root, "worker/packages"),
]);
const version = JSON.parse(
	fs.readFileSync(path.join(core, "package.json")),
).version;
const file = `cybergarage-orbit-${version}.tgz`;
const sha256 = createHash("sha256")
	.update(fs.readFileSync(path.join(root, "worker/packages", file)))
	.digest("hex");
if (
	version !== pinned.version ||
	file !== pinned.file ||
	sha256 !== pinned.sha256
)
	throw new Error(
		"Generated Core artifact differs from its pin; review and explicitly update the metadata and both locks",
	);
run(root, [
	"install",
	"--force",
	"--ignore-scripts",
	"--cache",
	path.join(os.tmpdir(), "orbit-app-npm-cache"),
	`file:worker/packages/${file}`,
]);
run(path.join(root, "worker"), [
	"install",
	"--force",
	"--ignore-scripts",
	"--cache",
	path.join(os.tmpdir(), "orbit-worker-npm-cache"),
	`file:packages/${file}`,
]);
// Keep lockfile formatting stable even when npm follows package.json indentation.
for (const directory of [root, path.join(root, "worker")]) {
	const lock = path.join(directory, "package-lock.json");
	fs.writeFileSync(
		lock,
		`${JSON.stringify(JSON.parse(fs.readFileSync(lock, "utf8")), null, 2)}\n`,
	);
}
fs.writeFileSync(metadataPath, `${JSON.stringify(pinned, null, 2)}\n`);
