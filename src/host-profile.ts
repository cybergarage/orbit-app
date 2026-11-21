import fs from "node:fs";
import path from "node:path";

const marker = ".orbit-app-host-agent-native-v2";
const version = "orbit-app-host-agent-native-v2\n";

/** Never adopt, move, copy or overwrite an existing App profile. */
export function openHostAgentProfile(legacyRoot: string): string {
	const base = path.resolve(legacyRoot);
	if (!path.isAbsolute(legacyRoot) || base === path.parse(base).root)
		throw new Error("Host Agent requires a dedicated profile");
	// On macOS an App path may be reached via a system alias. Register the
	// canonical parent before selecting the new sibling and requesting a lock.
	const parent = fs.realpathSync(path.dirname(base));
	const root = path.join(parent, `${path.basename(base)}-host-agent-native-v2`);
	const file = path.join(root, marker);
	try {
		fs.mkdirSync(root, { mode: 0o700 });
		fs.writeFileSync(file, version, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	assertNativeHostAgentProfile(root);
	return root;
}

export function assertNativeHostAgentProfile(root: string) {
	const file = path.join(root, marker);
	const directory = fs.lstatSync(root);
	const uid = process.getuid?.();
	if (
		!directory.isDirectory() ||
		(directory.mode & 0o077) !== 0 ||
		(uid !== undefined && directory.uid !== uid) ||
		fs.realpathSync(root) !== root
	)
		throw new Error(
			"Host Agent refused an unmarked or unsafe profile; no legacy profile was opened",
		);
	let stamp: fs.Stats | undefined;
	try {
		stamp = fs.lstatSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (
		!stamp?.isFile() ||
		stamp.nlink !== 1 ||
		(uid !== undefined && stamp.uid !== uid) ||
		(stamp.mode & 0o077) !== 0 ||
		stamp.size !== Buffer.byteLength(version) ||
		fs.readFileSync(file, "utf8") !== version
	)
		throw new Error(
			"Host Agent refused an unmarked or unsafe profile; no legacy profile was opened",
		);
}
