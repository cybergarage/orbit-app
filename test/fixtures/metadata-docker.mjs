import fs from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
const [file, verb, ...args] = process.argv.slice(2);
const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (state) => fs.writeFileSync(file, JSON.stringify(state));
if (verb === "writer") {
	setInterval(() => {}, 1000);
} else {
	const state = read();
	if (verb === "create") {
		state.name = args[args.indexOf("--name") + 1];
		state.id = createHash("sha256").update(state.name).digest("hex");
		state.labels = {};
		for (let index = 0; index < args.length; index++) {
			if (args[index] !== "--label") continue;
			const label = args[++index],
				split = label.indexOf("=");
			state.labels[label.slice(0, split)] = label.slice(split + 1);
		}
		state.creates = (state.creates ?? 0) + 1;
		state.exists = true;
		write(state);
		console.log(state.id);
	} else if (verb === "start") {
		if (state.mode === "normal") {
			state.exists = false;
			write(state);
			console.log(JSON.stringify({ result: "complete" }));
		} else {
			const writer = spawn(
				process.execPath,
				[import.meta.filename, file, "writer"],
				{
					detached: true,
					stdio: "ignore",
				},
			);
			writer.unref();
			state.writerPid = writer.pid;
			write(state);
			if (state.mode === "exit") process.exit(17);
			if (state.mode === "structured-error") {
				console.log(
					JSON.stringify({ error: "Project name changed; revision conflict" }),
				);
				process.exit(1);
			}
			if (state.mode === "output") process.stdout.write("x".repeat(4096));
			setInterval(() => {}, 1000);
		}
	} else if (verb === "ps") {
		if (state.exists) console.log(state.id);
	} else if (verb === "inspect") {
		const labels = { ...state.labels };
		if (state.wrongOwner)
			labels["org.cybergarage.orbit-app.metadata-owner"] = "foreign";
		console.log(
			JSON.stringify([
				{ Id: state.id, Name: `/${state.name}`, Config: { Labels: labels } },
			]),
		);
	} else if (verb === "rm") {
		if (state.refuse) process.exit(23);
		const remove = () => {
			const latest = read();
			if (latest.waitRemove && !fs.existsSync(`${file}.release`)) return false;
			try {
				process.kill(latest.writerPid, 0);
				latest.writerAliveAtRemove = true;
			} catch {}
			try {
				process.kill(latest.writerPid, "SIGKILL");
			} catch {}
			latest.exists = false;
			latest.mode = "normal";
			write(latest);
			return true;
		};
		if (!remove()) {
			const timer = setInterval(() => {
				if (remove()) {
					clearInterval(timer);
				}
			}, 10);
		}
	} else process.exit(24);
}
