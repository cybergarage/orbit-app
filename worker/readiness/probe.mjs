import { spawnSync } from "node:child_process";

// This image never reads arguments, stdin, project files or inherited shell
// configuration. The App's approved command is exactly the constant below.
const result = spawnSync(
	"/bin/bash",
	["--noprofile", "--norc", "-c", "printf 'workspace command ready\\n'"],
	{
		cwd: "/workspace",
		env: { HOME: "/tmp", PATH: "/usr/bin:/bin", LANG: "C.UTF-8", TZ: "UTC" },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 1500,
		killSignal: "SIGKILL",
		maxBuffer: 1024,
	},
);
if (
	result.error ||
	result.status !== 0 ||
	result.stdout !== "workspace command ready\n" ||
	result.stderr !== ""
) {
	process.exitCode = 1;
} else {
	process.stdout.write(JSON.stringify({ exitCode: 0, stdout: result.stdout }));
}
