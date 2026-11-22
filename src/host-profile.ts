import fs from "node:fs";
import path from "node:path";

const marker = ".orbit-app-host-agent-native-v2";
const version = "orbit-app-host-agent-native-v2\n";

function profilePaths(legacyRoot: string) {
	const base = path.resolve(legacyRoot);
	if (!path.isAbsolute(legacyRoot) || base === path.parse(base).root)
		throw new Error("Host Agent requires a dedicated profile");
	// On macOS an App path may be reached via a system alias. Register the
	// canonical parent before selecting the new sibling and requesting a lock.
	const parent = fs.realpathSync(path.dirname(base));
	const legacy = path.join(parent, path.basename(base));
	return { legacy, host: `${legacy}-host-agent-native-v2` };
}

function existing(pathname: string) {
	try {
		return fs.lstatSync(pathname);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return undefined;
	}
}

/** Select without writing, probing Docker, or recovering either profile. */
export function selectHostAgent(
	legacyRoot: string,
	override: string | undefined,
	freshHostDefault: boolean,
): boolean {
	if (override === "0") return false;
	if (override === "1") return true;
	if (override !== undefined)
		throw new Error("ORBIT_APP_HOST_AGENT must be 0 or 1 when specified");
	if (!freshHostDefault) return false;

	const { legacy, host } = profilePaths(legacyRoot);
	if (existing(host)) {
		// Do not silently hide a marked/unreadable Host profile by reverting.
		assertNativeHostAgentProfile(host);
		return true;
	}
	const base = existing(legacy);
	if (!base) return true;
	if (!base.isDirectory() || fs.realpathSync(legacy) !== legacy)
		throw new Error("Unsafe legacy App profile path");
	// Preserve all nonempty legacy roots without trying to classify/migrate them.
	return fs.readdirSync(legacy).length === 0;
}

/** Never adopt, move, copy or overwrite an existing App profile. */
export function openHostAgentProfile(legacyRoot: string): string {
	const { host: root } = profilePaths(legacyRoot);
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
