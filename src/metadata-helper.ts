import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { command, dockerArgs, dockerPath } from "./worker";

export interface MetadataTransport {
	command(args: string[]): Promise<string>;
	start(args: string[]): ChildProcessWithoutNullStreams;
}
const docker: MetadataTransport = {
	command: (args) => command(dockerPath, args),
	start: (args) => spawn(dockerPath, args, { stdio: ["pipe", "pipe", "pipe"] }),
};
interface HelperRecord {
	version: 1;
	name: string;
	token: string;
	root: string;
	core: string;
	ownerPid: number;
	id?: string;
}
export class MetadataRecoveryRequired extends Error {}
const marker = (root: string) => path.join(root, ".metadata-helper.json");
async function syncDirectory(root: string) {
	if (process.platform === "win32") return;
	const directory = await fs.open(root, "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}
async function readRecord(root: string): Promise<HelperRecord | undefined> {
	try {
		const stat = await fs.lstat(marker(root));
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			stat.size > 4096 ||
			(process.getuid && (stat.uid !== process.getuid() || stat.mode & 0o077))
		)
			throw new Error("Unsafe metadata recovery record");
		const record = JSON.parse(await fs.readFile(marker(root), "utf8"));
		if (
			record.version !== 1 ||
			record.root !== root ||
			!/^orbit-app-names-[a-f0-9-]{36}$/.test(record.name) ||
			!/^[a-f0-9-]{36}$/.test(record.token) ||
			!Number.isInteger(record.ownerPid) ||
			record.ownerPid < 1 ||
			(typeof record.id !== "undefined" && !/^[a-f0-9]{64}$/.test(record.id)) ||
			!(
				record.core === path.join(root, "catalog") ||
				(path.basename(record.core) === "core" &&
					/^[a-f0-9-]{36}$/.test(path.basename(path.dirname(record.core))) &&
					path.dirname(path.dirname(record.core)) ===
						path.join(root, "projects"))
			)
		)
			throw new Error("Invalid metadata recovery record");
		return record;
	} catch (error: any) {
		if (error.code === "ENOENT") return undefined;
		throw new MetadataRecoveryRequired(
			`Metadata recovery record requires review: ${String(error)}`,
		);
	}
}
async function saveRecord(record: HelperRecord, initial = false) {
	const file = marker(record.root);
	const temporary = initial ? file : `${file}.${randomUUID()}.tmp`;
	const handle = await fs.open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(JSON.stringify(record));
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		if (!initial) await fs.rename(temporary, file);
		await syncDirectory(record.root);
	} finally {
		if (!initial) await fs.rm(temporary, { force: true });
	}
}
async function forget(record: HelperRecord) {
	await fs.unlink(marker(record.root));
	await syncDirectory(record.root);
}
async function removeOwned(record: HelperRecord, transport: MetadataTransport) {
	const filter = record.id ? `id=${record.id}` : `name=^/${record.name}$`;
	const list = () =>
		transport.command([
			"ps",
			"-a",
			"--no-trunc",
			"--filter",
			filter,
			"--format",
			"{{.ID}}",
		]);
	const existing = (await list()).trim();
	if (existing) {
		if (
			!/^[a-f0-9]{64}$/.test(existing) ||
			(record.id && existing !== record.id)
		)
			throw new Error("Metadata helper identity is uncertain");
		const [container] = JSON.parse(
			await transport.command(["inspect", existing]),
		);
		const labels = container?.Config?.Labels;
		if (
			container?.Id !== existing ||
			container.Name !== `/${record.name}` ||
			labels?.["org.cybergarage.orbit-app.metadata-owner"] !== record.token ||
			labels?.["org.cybergarage.orbit-app.metadata-profile"] !== record.root ||
			labels?.["org.cybergarage.orbit-app.metadata-core"] !== record.core
		)
			throw new Error("Metadata helper ownership changed; shutdown refused");
		await transport.command(["rm", "-f", existing]);
		if ((await list()).trim())
			throw new Error("Metadata helper absence is unconfirmed");
	}
	await forget(record);
}
export async function assertMetadataHelperAbsent(root: string) {
	if (await readRecord(path.resolve(root)))
		throw new MetadataRecoveryRequired(
			"Metadata helper recovery required before shutdown or initialization",
		);
}
export async function recoverMetadataHelper(root: string, transport = docker) {
	root = path.resolve(root);
	await (await import("./store")).assertAppProfileRoot(root);
	const record = await readRecord(root);
	if (!record) return;
	if (record.ownerPid !== process.pid) {
		try {
			process.kill(record.ownerPid, 0);
			throw new Error(
				"Metadata helper owner is still alive; stop that App first",
			);
		} catch (error: any) {
			if (error.code !== "ESRCH") throw error;
		}
	}
	await removeOwned(record, transport);
}
export interface MetadataHelperOptions {
	transport?: MetadataTransport;
	timeoutMs?: number;
	outputLimit?: number;
}
export async function runMetadataHelper(
	root: string,
	core: string,
	request: Record<string, unknown>,
	options: MetadataHelperOptions = {},
) {
	root = path.resolve(root);
	core = path.resolve(core);
	const transport = options.transport ?? docker;
	const input = `${JSON.stringify(request)}\n`;
	if (await readRecord(root))
		throw new MetadataRecoveryRequired(
			"Metadata helper recovery required; stop other App instances and run npm run metadata:recover -- <profile>",
		);
	const timeout = options.timeoutMs ?? 30000;
	const limit = options.outputLimit ?? 2e6;
	if (timeout < 1 || timeout > 30000 || limit < 1 || limit > 2e6)
		throw new Error("Invalid metadata helper bounds");
	const record: HelperRecord = {
		version: 1,
		name: `orbit-app-names-${randomUUID()}`,
		token: randomUUID(),
		root,
		core,
		ownerPid: process.pid,
	};
	try {
		await saveRecord(record, true);
	} catch (error) {
		throw new MetadataRecoveryRequired(
			`Cannot establish metadata helper ownership record: ${String(error)}`,
		);
	}
	const catalog = path.join(root, "catalog");
	const args = dockerArgs(record.name, catalog, core);
	args[0] = "create";
	const image = args.pop();
	if (!image) throw new Error("Missing worker image");
	const mount = args.findIndex((arg) => arg.endsWith("dst=/workspace"));
	args[mount] = `type=bind,src=${catalog},dst=/catalog`;
	args.push(
		"--label",
		`org.cybergarage.orbit-app.metadata-owner=${record.token}`,
		"--label",
		`org.cybergarage.orbit-app.metadata-profile=${root}`,
		"--label",
		`org.cybergarage.orbit-app.metadata-core=${core}`,
		"--workdir",
		"/opt/worker",
		"--entrypoint",
		"node",
		image,
		"/opt/worker/names.mjs",
	);
	try {
		const id = (await transport.command(args)).trim();
		if (!/^[a-f0-9]{64}$/.test(id))
			throw new Error("Invalid created metadata helper ID");
		record.id = id;
		await saveRecord(record);
		// The identity is durable before start: a killed CLI cannot hide a late-starting writer.
		const child = transport.start(["start", "--attach", "--interactive", id]);
		let output = "",
			stderr = "",
			bytes = 0;
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (error) {
					child.kill("SIGKILL");
					reject(error);
				} else resolve();
			};
			const timer = setTimeout(
				() => finish(new Error("Core metadata request timed out")),
				timeout,
			);
			child.stdout.on("data", (part) => {
				bytes += part.length;
				if (bytes > limit)
					finish(new Error("Core metadata output limit exceeded"));
				else output += part;
			});
			child.stderr.on("data", (part) => {
				stderr = (stderr + part).slice(-2000);
			});
			child.once("error", (error) => finish(error));
			child.once("close", (code) =>
				finish(
					code === 0
						? undefined
						: new Error(stderr || `Metadata CLI exit ${code}`),
				),
			);
			child.stdin.on("error", () => {});
			child.stdin.end(input);
		});
		const result = JSON.parse(output);
		if (result.error) throw new Error(result.error);
		await forget(record);
		return result.result;
	} catch (error) {
		try {
			await removeOwned(record, transport);
		} catch (cleanup) {
			throw new MetadataRecoveryRequired(
				`Metadata helper stop is unconfirmed; profile blocked until explicit recovery: ${String(cleanup)}`,
			);
		}
		throw error;
	}
}
