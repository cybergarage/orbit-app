import { createHash, randomUUID } from "node:crypto";
import { constants as flags } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "/workspace";
const MAX_BYTES = 1024 * 1024;
const DIR_FLAGS = flags.O_RDONLY | flags.O_DIRECTORY | flags.O_NOFOLLOW;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

class Refused extends Error {}

function refuse(message) {
	throw new Refused(message);
}

function digest(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function validHash(value) {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function keysWithin(value, allowed) {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).every((key) => allowed.includes(key))
	);
}

function relative(containerPath, allowRoot = false) {
	if (allowRoot && containerPath === ROOT) return [];
	if (
		typeof containerPath !== "string" ||
		!containerPath.startsWith(`${ROOT}/`) ||
		/[\\\0]/.test(containerPath)
	)
		refuse("Invalid workspace path");
	const parts = containerPath.slice(ROOT.length + 1).split("/");
	if (parts.length > 128 || parts.some((p) => !p || p === "." || p === ".."))
		refuse("Invalid workspace path");
	return parts;
}

function mutation(value) {
	if (
		!keysWithin(value, [
			"version",
			"name",
			"effect",
			"cwd",
			"target",
			"input",
			"preimageSha256",
			"resultSha256",
		]) ||
		value.version !== 1 ||
		value.effect !== "write" ||
		!validHash(value.resultSha256) ||
		(value.preimageSha256 !== null && !validHash(value.preimageSha256))
	)
		refuse("Invalid prepared mutation");
	relative(value.cwd, true);
	const parts = relative(value.target);
	const input = value.input;
	if (value.name === "write") {
		if (
			!keysWithin(input, ["path", "content", "createDirectories"]) ||
			typeof input.content !== "string" ||
			(input.createDirectories !== undefined &&
				typeof input.createDirectories !== "boolean")
		)
			refuse("Invalid write input");
	} else if (value.name === "edit") {
		if (
			!keysWithin(input, ["path", "oldText", "newText", "replaceAll"]) ||
			typeof input.oldText !== "string" ||
			!input.oldText ||
			typeof input.newText !== "string" ||
			value.preimageSha256 === null ||
			(input.replaceAll !== undefined && typeof input.replaceAll !== "boolean")
		)
			refuse("Invalid edit input");
	} else {
		refuse("Workspace operation is not supported by this runner");
	}
	if (input.path !== value.target) refuse("Target does not match input");
	return parts;
}

function childOf(directory, name) {
	return `/proc/self/fd/${directory.fd}/${name}`;
}

/** Open each directory component without following symlinks. Linux container only. */
async function withTarget(root, parts, run) {
	const handles = [];
	try {
		try {
			handles.push(await fs.open(root, DIR_FLAGS));
			for (const component of parts.slice(0, -1)) {
				handles.push(
					await fs.open(childOf(handles.at(-1), component), DIR_FLAGS),
				);
			}
		} catch (error) {
			if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code))
				refuse("Workspace parent is missing or not a directory");
			throw error;
		}
		return await run(
			handles.at(-1),
			parts.at(-1),
			path.join(root, ...parts.slice(0, -1)),
		);
	} finally {
		for (const handle of handles.reverse()) await handle.close();
	}
}

async function readRegular(file) {
	let handle;
	try {
		const proposed = await fs.lstat(file);
		if (!proposed.isFile() || proposed.nlink !== 1 || proposed.size > MAX_BYTES)
			refuse("Workspace target is not a bounded regular file");
		handle = await fs.open(
			file,
			flags.O_RDONLY | flags.O_NOFOLLOW | flags.O_NONBLOCK,
		);
	} catch (error) {
		if (error.code === "ENOENT") return null;
		if (error.code === "ELOOP")
			refuse("Workspace target must not be a symlink");
		throw error;
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES)
			refuse("Workspace target is not a bounded regular file");
		const bytes = Buffer.alloc(MAX_BYTES + 1);
		let used = 0;
		while (used < bytes.length) {
			const { bytesRead } = await handle.read(
				bytes,
				used,
				bytes.length - used,
				null,
			);
			if (!bytesRead) break;
			used += bytesRead;
		}
		if (used > MAX_BYTES) refuse("Workspace target exceeds byte limit");
		return { bytes: bytes.subarray(0, used), mode: stat.mode & 0o777 };
	} finally {
		await handle.close();
	}
}

/** Internal diagnostic only. A byte match never proves execution or no effects. */
export async function observeExistingEdit(evidence, root = ROOT) {
	if (
		!keysWithin(evidence, ["target", "preimageSha256", "resultSha256"]) ||
		typeof evidence.target !== "string" ||
		!validHash(evidence.preimageSha256) ||
		!validHash(evidence.resultSha256) ||
		evidence.preimageSha256 === evidence.resultSha256
	)
		return "unverified";

	try {
		const parts = relative(evidence.target);
		return await withTarget(root, parts, async (directory, name, parent) => {
			const parentLink = `/proc/self/fd/${directory.fd}`;
			if ((await fs.readlink(parentLink)) !== parent) return "unverified";
			const current = await readRegular(childOf(directory, name));
			if (!current || (await fs.readlink(parentLink)) !== parent)
				return "unverified";
			const actual = digest(current.bytes);
			if (actual === evidence.preimageSha256) return "original-bytes-observed";
			if (actual === evidence.resultSha256) return "expected-bytes-observed";
			return "different-bytes-observed";
		});
	} catch {
		return "unverified";
	}
}

function verifiedPreimage(previous, expected) {
	const actual = previous === null ? null : digest(previous.bytes);
	if (actual !== expected) refuse("Workspace target changed after preparation");
}

function replacement(operation, previous) {
	if (operation.name === "write") return Buffer.from(operation.input.content);
	const { oldText, newText, replaceAll } = operation.input;
	let old;
	try {
		old = utf8.decode(previous.bytes);
	} catch {
		refuse("Workspace edit requires valid UTF-8");
	}
	const pieces = old.split(oldText);
	if (pieces.length === 1 || (!replaceAll && pieces.length !== 2))
		refuse("Prepared edit is ambiguous");
	if (
		old.length + (pieces.length - 1) * (newText.length - oldText.length) >
		MAX_BYTES
	)
		refuse("Workspace edit result exceeds byte limit");
	return Buffer.from(pieces.join(newText));
}

async function stagedMutation(directory, name, expectedParent, operation) {
	const target = childOf(directory, name);
	const verifyParent = async () => {
		if ((await fs.readlink(`/proc/self/fd/${directory.fd}`)) !== expectedParent)
			refuse("Workspace parent changed after preparation");
	};
	await verifyParent();
	const previous = await readRegular(target);
	verifiedPreimage(previous, operation.preimageSha256);
	const bytes = replacement(operation, previous);
	if (operation.name === "edit" && bytes.equals(previous.bytes))
		refuse("Prepared edit does not change the target");
	if (bytes.length > MAX_BYTES || digest(bytes) !== operation.resultSha256)
		refuse("Workspace result does not match the prepared digest");
	const temporary = childOf(directory, `.orbit-workspace-${randomUUID()}.tmp`);
	const handle = await fs.open(temporary, "wx", previous?.mode ?? 0o600);
	let committed = false;
	try {
		try {
			await handle.writeFile(bytes);
			if (previous) await handle.chmod(previous.mode);
			await handle.sync();
		} finally {
			await handle.close();
		}
		verifiedPreimage(await readRegular(target), operation.preimageSha256);
		await verifyParent();
		if (previous === null) {
			// link() provides a no-replace commit for a path prepared as absent.
			await fs.link(temporary, target);
			committed = true;
			await fs.unlink(temporary);
		} else {
			await fs.rename(temporary, target);
			committed = true;
		}
		await directory.sync();
		await verifyParent();
		const result = await readRegular(target);
		if (!result || digest(result.bytes) !== operation.resultSha256)
			throw new Error("Workspace result could not be verified after mutation");
		return {
			content: [{ type: "text", text: "Workspace mutation completed." }],
		};
	} catch (error) {
		if (!committed) {
			await fs.unlink(temporary);
			if (previous === null && error.code === "EEXIST")
				refuse("Workspace target changed after preparation");
		}
		// No known-failure response after a possible effect.
		if (committed && error instanceof Refused)
			throw new Error("Unknown mutation outcome");
		throw error;
	}
}

/** Return only acknowledged outcomes. Other errors must remain uncertain to the caller. */
export async function executeWorkspaceMutation(value, root = ROOT) {
	try {
		const parts = mutation(value);
		return await withTarget(root, parts, (directory, name, parent) =>
			stagedMutation(directory, name, parent, value),
		);
	} catch (error) {
		if (!(error instanceof Refused)) throw error;
		return { content: [{ type: "text", text: error.message }], isError: true };
	}
}

async function requestFrom(input) {
	let size = 0;
	const chunks = [];
	for await (const chunk of input) {
		size += chunk.length;
		if (size > MAX_BYTES) refuse("Workspace request exceeds byte limit");
		chunks.push(chunk);
	}
	try {
		return JSON.parse(utf8.decode(Buffer.concat(chunks, size)));
	} catch {
		refuse("Invalid workspace request JSON");
	}
}

if (
	process.argv[1] &&
	pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
	try {
		const operation = await requestFrom(process.stdin);
		const result = await executeWorkspaceMutation(operation);
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} catch (error) {
		if (error instanceof Refused)
			process.stdout.write(
				`${JSON.stringify({
					content: [{ type: "text", text: error.message }],
					isError: true,
				})}\n`,
			);
		else process.exitCode = 1; // Error/termination after dispatch: no replay or fallback.
	}
}
