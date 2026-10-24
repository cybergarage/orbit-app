import { holdSourceNamespace, sourceProfileRoot } from "./source-namespace";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { ProjectSourceCapture } from "@cybergarage/orbit";
import { command, dockerArgs, dockerPath } from "./worker";

export interface SourceLease {
	containerName?: string;
	captures: ProjectSourceCapture[];
	assertHeld(): void;
	release(): Promise<void>;
}
export type AcquireSources = (
	core: string,
	sessionIds: string[],
) => Promise<SourceLease>;
/** Each helper opens only its original /state pair. It has no model, network or catalog authority. */
export const acquireContainerSources: AcquireSources = async (
	core,
	sessionIds,
) => {
	const namespace = await holdSourceNamespace(sourceProfileRoot(core));
	const name = `orbit-app-source-${randomUUID()}`;
	const args = dockerArgs(name, core, core);
	const image = args.pop();
	if (!image) throw new Error("Worker image missing");
	const mount = args.findIndex((arg) => arg.endsWith("dst=/workspace"));
	args.splice(mount - 1, 2);
	args.push(
		"--pid",
		`container:${namespace.name}`,
		"--workdir",
		"/opt/worker",
		"--entrypoint",
		"node",
		image,
		"/opt/worker/sources.mjs",
	);
	const child = spawn(dockerPath, args, { stdio: ["pipe", "pipe", "pipe"] });
	let bytes = 0,
		stderr = "",
		response: any,
		released = false,
		settled = false;
	const expires = Date.now() + 40000;
	const closed = new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) =>
			code === 0
				? resolve()
				: reject(
						new Error(
							`${response?.error ?? stderr ?? "Source helper failed"} (exit ${code})`,
						),
					),
		);
	});
	void closed.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	child.stderr.on("data", (part) => {
		stderr = (stderr + part).slice(-2000);
	});
	child.stdout.on("data", (part) => {
		bytes += part.length;
		if (bytes > 4 * 1024 * 1024 + 1024) child.kill();
	});
	child.stdin.on("error", () => {});
	const lines = createInterface({ input: child.stdout });
	const reply = new Promise<ProjectSourceCapture[]>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("Source helper acquisition timed out")),
			30000,
		);
		lines.once("line", (line) => {
			clearTimeout(timer);
			try {
				response = JSON.parse(line);
				if (response.error) throw new Error(response.error);
				resolve(response.captures);
			} catch (error) {
				reject(error);
			}
		});
		void closed.then(
			() => {
				clearTimeout(timer);
				if (!response) reject(new Error("Source helper closed before capture"));
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
	const release = async () => {
		if (released) return;
		released = true;
		child.stdin.end("release\n");
		let timer: ReturnType<typeof setTimeout> | undefined;
		let gone = false;
		try {
			await Promise.race([
				closed,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("Source release timed out")),
						5000,
					);
				}),
			]);
			gone = true;
		} catch (error) {
			const existing = await command(dockerPath, [
				"ps",
				"-a",
				"--filter",
				`name=^/${name}$`,
				"--format",
				"{{.Names}}",
			]);
			if (existing.trim()) await command(dockerPath, ["rm", "-f", name]);
			const remaining = await command(dockerPath, [
				"ps",
				"-a",
				"--filter",
				`name=^/${name}$`,
				"--format",
				"{{.Names}}",
			]);
			if (remaining.trim())
				throw new Error("Source helper shutdown is unconfirmed");
			gone = true;
			throw error;
		} finally {
			if (timer) clearTimeout(timer);
			lines.close();
			if (gone) namespace.release();
		}
	};

	child.stdin.write(`${JSON.stringify({ sessionIds })}\n`);
	try {
		return {
			containerName: name,
			captures: await reply,
			release,
			assertHeld() {
				if (released || settled || Date.now() > expires)
					throw new Error("Source lease lost or expired");
			},
		};
	} catch (error) {
		await release();
		throw error;
	}
};
