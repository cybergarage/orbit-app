import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { dockerArgs, dockerPath } from "./worker";
export interface CoreNames {
	call(core: string, request: Record<string, unknown>): Promise<any>;
}
export class ContainerCoreNames implements CoreNames {
	private operations: Promise<unknown> = Promise.resolve();
	constructor(private readonly root: string) {}
	call(core: string, request: Record<string, unknown>) {
		const operation = this.operations.then(() =>
			this.performCall(core, request),
		);
		this.operations = operation.catch(() => {});
		return operation;
	}
	private async performCall(core: string, request: Record<string, unknown>) {
		const catalog = path.join(this.root, "catalog");
		if (request.command !== "create-project") {
			await fs.access(path.join(catalog, "projects.sqlite"));
			if (!(await fs.stat(core)).isDirectory())
				throw new Error("Core storage directory is missing");
		} else {
			await fs.mkdir(catalog, { recursive: true, mode: 0o700 });
			await fs.mkdir(core, { recursive: true, mode: 0o700 });
		}
		const args = dockerArgs(
			`orbit-app-names-${crypto.randomUUID()}`,
			catalog,
			core,
		);
		const image = args.pop();
		if (!image) throw new Error("Missing worker image");
		// Catalog mounts replace the workspace mount for metadata-only operations.
		const mount = args.findIndex((arg) => arg.endsWith("dst=/workspace"));
		args[mount] = `type=bind,src=${catalog},dst=/catalog`;
		args.push(
			"--workdir",
			"/opt/worker",
			"--entrypoint",
			"node",
			image,
			"/opt/worker/names.mjs",
		);
		return new Promise<any>((resolve, reject) => {
			const child = spawn(dockerPath, args, {
				stdio: ["pipe", "pipe", "pipe"],
			});
			let output = "",
				error = "";
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				reject(
					new Error("Core metadata request timed out; refresh before retrying"),
				);
			}, 30000);
			child.stdout.on("data", (bytes) => {
				output += bytes;
				if (output.length > 2e6) child.kill("SIGKILL");
			});
			child.stderr.on("data", (bytes) => {
				error = (error + bytes).slice(-2000);
			});
			child.on("error", (e) => {
				clearTimeout(timer);
				reject(e);
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				try {
					const result = JSON.parse(output);
					if (code !== 0)
						throw new Error(
							result.error || error || "Core metadata process failed",
						);
					if (result.error) throw new Error(result.error);
					resolve(result.result);
				} catch (e) {
					reject(new Error(error || String(e)));
				}
			});
			child.stdin.on("error", () => {});
			child.stdin.end(`${JSON.stringify(request)}\n`);
		});
	}
}
