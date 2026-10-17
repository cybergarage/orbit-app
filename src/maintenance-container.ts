import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { command, dockerPath, image, workerUserArgs } from "./worker";

/** This helper never receives workspaces, catalog, home, credentials or Docker socket mounts. */
export async function containerMaintenance(
	core: string,
	request: Record<string, unknown>,
): Promise<any> {
	if (!core.startsWith("/") || /[,\r\n]/.test(core))
		throw new Error("Unsafe core mount");
	const name = `orbit-app-maintenance-${randomUUID()}`;
	let timedOut = false;
	let result: any;
	let failure: unknown;
	try {
		result = await new Promise((resolve, reject) => {
			const child = spawn(
				dockerPath,
				[
					"run",
					"--rm",
					"--pull=never",
					"-i",
					"--name",
					name,
					"--network",
					"none",
					"--read-only",
					"--cap-drop",
					"ALL",
					"--security-opt",
					"no-new-privileges",
					"--pids-limit",
					"64",
					"--memory",
					"512m",
					"--cpus",
					"1",
					"--tmpfs",
					"/tmp:rw,noexec,nosuid,size=64m",
					"--mount",
					`type=bind,src=${core},dst=/state${request.action !== "execute" ? ",readonly" : ""}`,
					...workerUserArgs(),
					"--workdir",
					"/opt/worker",
					"--entrypoint",
					"node",
					image,
					"/opt/worker/maintenance.mjs",
				],
				{ stdio: ["pipe", "pipe", "pipe"] },
			);
			let output = "";
			let error = "";
			const timeout = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, 30000);
			child.stdout.on("data", (b) => {
				output += b;
				if (output.length > 2e6) child.kill("SIGKILL");
			});
			child.stderr.on("data", (b) => {
				error = (error + b).slice(-2000);
			});
			child.on("error", (e) => {
				clearTimeout(timeout);
				reject(e);
			});
			child.on("close", (code) => {
				clearTimeout(timeout);
				try {
					if (timedOut)
						throw new Error(
							"Maintenance timed out; completion is uncertain. Keep writers stopped.",
						);
					const response = JSON.parse(output);
					if (code !== 0 || response.error)
						throw new Error(response.error || error || "Maintenance failed");
					resolve(response.result);
				} catch (e) {
					reject(e);
				}
			});
			child.stdin.on("error", () => {});
			child.stdin.end(`${JSON.stringify(request)}\n`);
		});
	} catch (error) {
		failure = error;
	}
	if (timedOut) await command(dockerPath, ["rm", "-f", name]).catch(() => {});
	const remaining = await command(dockerPath, [
		"ps",
		"-a",
		"--filter",
		`name=^/${name}$`,
		"--format",
		"{{.Names}}",
	]);
	if (remaining.trim())
		throw new Error(
			"Maintenance container shutdown is unconfirmed; keep writers stopped",
		);
	if (failure) throw failure;
	return result;
}
