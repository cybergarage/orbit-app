import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fastGlob from "fast-glob";
import ignore from "ignore";
import { safePatterns } from "./policy.mjs";

const ROOT = "/workspace";
const INPUT = 32 * 1024;
const OUTPUT = 1024 * 1024; // Core's serialized WorkspaceExecutor result limit.
const MAX_TEXT = 200_000; // Core's read/grep text limit (before JSON escaping).
const FILE = 8 * 1024 * 1024;
const TOTAL = 32 * 1024 * 1024;
const ENTRIES = 12_000;
const DEFAULT_LIMIT = 2000;
const IMPLICIT_IGNORE = [
	"**/.git/**",
	"**/node_modules/**",
	"**/dist/**",
	"**/coverage/**",
];
const DIR =
	fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const REGULAR =
	fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const BY_NAME = (a, b) => a.localeCompare(b, "en");
const errorResult = (message) => ({
	content: [{ type: "text", text: message }],
	isError: true,
});
const result = (text, details) => ({
	content: [{ type: "text", text }],
	details,
});
class Refused extends Error {}
const refuse = (message) => {
	throw new Refused(message);
};

function includesOnly(value, names) {
	return (
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).every((key) => names.includes(key))
	);
}
function segments(value) {
	if (value === ROOT) return [];
	if (
		typeof value !== "string" ||
		!value.startsWith(`${ROOT}/`) ||
		/[\\\0]/.test(value)
	)
		refuse("Invalid workspace path");
	const parts = value.slice(ROOT.length + 1).split("/");
	if (
		parts.length > 128 ||
		parts.some((part) => !part || part === "." || part === "..")
	)
		refuse("Invalid workspace path");
	return parts;
}
const fields = {
	read: ["limit", "offset"],
	list: ["limit", "includeHidden"],
	glob: ["limit", "includeHidden", "includeDirectories", "pattern"],
	grep: ["limit", "ignoreCase", "literal", "contextLines", "pattern", "glob"],
};
function validate(value) {
	if (
		!includesOnly(value, [
			"version",
			"effect",
			"name",
			"cwd",
			"target",
			"input",
		]) ||
		value.version !== 1 ||
		value.effect !== "read" ||
		value.cwd !== ROOT ||
		!Object.hasOwn(fields, value.name) ||
		!includesOnly(value.input, ["path", ...fields[value.name]]) ||
		value.input.path !== value.target
	)
		refuse("Invalid prepared workspace observation");
	segments(value.target);
	const input = value.input;
	for (const key of [
		"includeHidden",
		"includeDirectories",
		"ignoreCase",
		"literal",
	]) {
		if (input[key] !== undefined && typeof input[key] !== "boolean")
			refuse("Invalid observation flags");
	}
	for (const [key, min, max] of [
		["limit", 1, value.name === "glob" ? 100_000 : 20_000],
		["offset", 1, Number.MAX_SAFE_INTEGER],
		["contextLines", 0, 20],
	]) {
		if (
			input[key] !== undefined &&
			(!Number.isSafeInteger(input[key]) ||
				input[key] < min ||
				input[key] > max)
		)
			refuse("Invalid observation limit");
	}
	function checkGlob(pattern) {
		if (
			!safePatterns(pattern) ||
			[pattern]
				.flat()
				.some(
					(part) =>
						!part ||
						part.startsWith("/") ||
						part.includes("..") ||
						part.includes("\0") ||
						part.replace(/^!+/, "").startsWith("/"),
				)
		)
			refuse("Search patterns must stay within their declared base");
	}
	if (value.name === "glob") checkGlob(input.pattern ?? null);
	if (value.name === "grep") {
		if (
			typeof input.pattern !== "string" ||
			!input.pattern ||
			input.pattern.length > 4096
		)
			refuse("Invalid search expression");
		if (input.glob !== undefined) {
			if (typeof input.glob !== "string") refuse("Invalid file filter");
			checkGlob(input.glob);
		}
	}
}

function filesystem(root) {
	const rootFd = fs.openSync(root, DIR);
	let entries = 0,
		bytes = 0;
	const fdPath = (fd, name) =>
		`/proc/self/fd/${fd}${name === undefined ? "" : `/${name}`}`;
	function withTarget(target, fn) {
		const parts = segments(target),
			parents = [];
		try {
			let fd = rootFd;
			for (const entry of parts.slice(0, -1)) {
				fd = fs.openSync(fdPath(fd, entry), DIR);
				parents.push(fd);
			}
			return fn(fd, parts.at(-1));
		} finally {
			for (const fd of parents.reverse()) fs.closeSync(fd);
		}
	}
	const stat = (target) =>
		withTarget(target, (fd, name) =>
			name === undefined ? fs.fstatSync(fd) : fs.lstatSync(fdPath(fd, name)),
		);
	function readdir(target, options) {
		return withTarget(target, (fd, name) => {
			const child =
				name === undefined ? fd : fs.openSync(fdPath(fd, name), DIR);
			try {
				const directory = fs.opendirSync(fdPath(child));
				try {
					const out = [];
					for (
						let entry = directory.readSync();
						entry;
						entry = directory.readSync()
					) {
						if (++entries > ENTRIES) refuse("Workspace entry budget exceeded");
						out.push(options?.withFileTypes ? entry : entry.name);
					}
					return out;
				} finally {
					directory.closeSync();
				}
			} finally {
				if (child !== fd) fs.closeSync(child);
			}
		});
	}
	function readFile(target) {
		return withTarget(target, (fd, name) => {
			if (name === undefined) refuse("Cannot read workspace root as a file");
			const file = fdPath(fd, name);
			const proposed = fs.lstatSync(file);
			if (!proposed.isFile() || proposed.nlink !== 1 || proposed.size > FILE)
				refuse("Workspace input is not a bounded regular file");
			const handle = fs.openSync(file, REGULAR);
			try {
				const info = fs.fstatSync(handle);
				if (!info.isFile() || info.nlink !== 1 || info.size > FILE)
					refuse("Workspace input is not a bounded regular file");
				const chunks = [];
				let used = 0;
				for (;;) {
					const chunk = Buffer.alloc(64 * 1024);
					const count = fs.readSync(handle, chunk, 0, chunk.length, null);
					if (!count) break;
					bytes += count;
					used += count;
					if (bytes > TOTAL || used > FILE)
						refuse("Workspace read byte budget exceeded");
					chunks.push(chunk.subarray(0, count));
				}
				return Buffer.concat(chunks, used);
			} finally {
				fs.closeSync(handle);
			}
		});
	}
	return { close: () => fs.closeSync(rootFd), stat, readFile, readdir };
}

function truncate(text) {
	const binary = Buffer.from(text);
	if (binary.length <= MAX_TEXT) return { text, truncated: false };
	let end = MAX_TEXT;
	while ((binary[end] & 0xc0) === 0x80) end--;
	const prefix = binary.subarray(0, end).toString("utf8");
	return { text: `${prefix}\n[output truncated]`, truncated: true };
}
function accepts(fsView, base) {
	const matcher = ignore();
	try {
		matcher.add(
			fsView.readFile(path.posix.join(base, ".gitignore")).toString("utf8"),
		);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	return (candidate, directory = false) => {
		const relative = path.posix.relative(base, candidate);
		return !relative || !matcher.ignores(directory ? `${relative}/` : relative);
	};
}
function candidates(fsView, base, pattern, dot, onlyFiles) {
	return fastGlob.sync(pattern, {
		absolute: true,
		cwd: base,
		dot,
		followSymbolicLinks: false,
		ignore: IMPLICIT_IGNORE,
		onlyFiles,
		unique: true,
		suppressErrors: false,
		fs: {
			lstatSync: fsView.stat,
			statSync: fsView.stat,
			readdirSync: fsView.readdir,
		},
	});
}
function read(fsView, target, input, info, limit) {
	if (info.isDirectory())
		return errorResult(`Cannot read directory: ${target}. Use list instead.`);
	if (!info.isFile())
		return errorResult(`Cannot read non-file path: ${target}`);
	const buffer = fsView.readFile(target);
	if (buffer.includes(0))
		return errorResult(`Cannot read binary file as UTF-8 text: ${target}`);
	const lines = buffer.toString("utf8").split(/\r?\n/u),
		offset = input.offset ?? 1;
	const truncated = truncate(
		lines.slice(offset - 1, offset - 1 + limit).join("\n"),
	);
	const end = Math.min(lines.length, offset + limit - 1);
	return result(truncated.text, {
		encoding: "utf8",
		endLine: end,
		path: target,
		startLine: offset,
		totalLines: lines.length,
		truncated: truncated.truncated || end < lines.length,
	});
}
function list(fsView, target, input, info, limit) {
	if (!info.isDirectory())
		return errorResult(`Cannot list non-directory path: ${target}`);
	const all = fsView
		.readdir(target, { withFileTypes: true })
		.filter((entry) => input.includeHidden || !entry.name.startsWith("."))
		.sort((a, b) => BY_NAME(a.name, b.name));
	const entries = all.slice(0, limit).map((entry) => ({
		name: entry.name,
		kind: entry.isDirectory()
			? "directory"
			: entry.isFile()
				? "file"
				: entry.isSymbolicLink()
					? "symlink"
					: "other",
	}));
	return result(
		entries.map((entry) => `${entry.kind}\t${entry.name}`).join("\n") ||
			"[empty directory]",
		{
			entries,
			omitted: all.length - entries.length,
			path: target,
			truncated: entries.length < all.length,
		},
	);
}
function glob(fsView, target, input, info, limit) {
	if (!info.isDirectory())
		return errorResult(`Glob base path is not a directory: ${target}`);
	const matches = candidates(
		fsView,
		target,
		input.pattern,
		!!input.includeHidden,
		!input.includeDirectories,
	);
	const accepted = accepts(fsView, target);
	const all = [];
	for (const candidate of matches) {
		const directory = fsView.stat(candidate).isDirectory();
		if (accepted(candidate, directory)) all.push({ directory, candidate });
	}
	all.sort((a, b) => BY_NAME(a.candidate, b.candidate));
	const selected = all.slice(0, limit);
	return result(
		selected
			.map(({ directory, candidate }) =>
				directory ? `${candidate}/` : candidate,
			)
			.join("\n") || "[no matches]",
		{
			matches: selected.map(({ candidate }) => candidate),
			omitted: all.length - selected.length,
			truncated: selected.length < all.length,
		},
	);
}
function grep(fsView, target, input, info, limit) {
	if (!info.isDirectory() && !info.isFile())
		return errorResult(`Cannot read non-file path: ${target}`);
	const base = info.isDirectory() ? target : path.posix.dirname(target);
	const files = info.isDirectory()
		? candidates(fsView, base, input.glob ?? "**/*", true, true)
		: [target];
	const accepted = accepts(fsView, base);
	const source = input.literal
		? input.pattern.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)
		: input.pattern;
	let expression;
	try {
		expression = new RegExp(source, input.ignoreCase ? "giu" : "gu");
	} catch (error) {
		return errorResult(`Invalid search expression: ${error.message}`);
	}
	const matches = [],
		rendered = [];
	let detailsBytes = 0;
	for (const file of files.sort(BY_NAME)) {
		if (!accepted(file)) continue;
		const buffer = fsView.readFile(file);
		if (buffer.includes(0)) continue;
		const lines = buffer.toString("utf8").split(/\r?\n/u);
		for (const [index, line] of lines.entries()) {
			expression.lastIndex = 0;
			for (
				let match = expression.exec(line);
				match !== null;
				match = expression.exec(line)
			) {
				const before = [],
					after = [],
					contextLines = input.contextLines ?? 0;
				for (
					let i = Math.max(0, index - contextLines);
					i < Math.min(lines.length, index + contextLines + 1);
					i++
				)
					if (i < index) before.push({ line: i + 1, text: lines[i] });
					else if (i > index) after.push({ line: i + 1, text: lines[i] });
				const entry = {
					column: match.index + 1,
					...(contextLines ? { context: [...before, ...after] } : {}),
					line: index + 1,
					path: file,
					text: line,
				};
				detailsBytes += Buffer.byteLength(JSON.stringify(entry));
				if (detailsBytes >= OUTPUT)
					refuse("Workspace result exceeds byte limit");
				matches.push(entry);
				rendered.push(
					...before.map((v) => `${file}-${v.line}-${v.text}`),
					`${file}:${entry.line}:${entry.column}:${line}`,
					...after.map((v) => `${file}-${v.line}-${v.text}`),
				);
				if (matches.length >= limit) break;
				if (!match[0].length) {
					const code = line.codePointAt(expression.lastIndex);
					expression.lastIndex += code !== undefined && code > 0xffff ? 2 : 1;
				}
			}
			if (matches.length >= limit) break;
		}
		if (matches.length >= limit) break;
	}
	const truncated = truncate(rendered.join("\n") || "[no matches]");
	return result(truncated.text, {
		matches,
		truncated: truncated.truncated || matches.length >= limit,
	});
}

export function observe(value, root = ROOT) {
	let view;
	try {
		validate(value);
		view = filesystem(root);
		const { name, target, input } = value;
		const info = view.stat(target);
		const answer = { read, list, glob, grep }[name](
			view,
			target,
			input,
			info,
			input.limit ?? DEFAULT_LIMIT,
		);
		if (Buffer.byteLength(JSON.stringify(answer)) > OUTPUT)
			return errorResult("Workspace result exceeds byte limit");
		return answer;
	} catch (error) {
		if (error instanceof Refused) return errorResult(error.message);
		if (
			["EACCES", "EISDIR", "ELOOP", "ENOENT", "ENOTDIR", "EPERM"].includes(
				error?.code,
			)
		)
			return errorResult(`Workspace path could not be read (${error.code})`);
		throw error;
	} finally {
		view?.close();
	}
}
async function main() {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of process.stdin) {
		bytes += chunk.length;
		if (bytes > INPUT) {
			process.stdout.write(
				JSON.stringify(
					errorResult("Workspace observation exceeds request limit"),
				),
			);
			break;
		}
		chunks.push(chunk);
	}
	if (bytes > INPUT) return;
	let operation;
	try {
		const frame = new TextDecoder("utf-8", { fatal: true }).decode(
			Buffer.concat(chunks),
		);
		if (frame.trim().includes("\n")) throw new Error("Multiline JSON");
		operation = JSON.parse(frame);
	} catch {
		process.stdout.write(
			JSON.stringify(errorResult("Invalid workspace observation frame")),
		);
		return;
	}
	process.stdout.write(JSON.stringify(observe(operation)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	await main();
