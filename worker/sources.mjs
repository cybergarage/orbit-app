import { createInterface } from "node:readline";
import { ProjectSourceLease, SessionRepository } from "@cybergarage/orbit";
const lines = createInterface({ input: process.stdin });
let lease;
const timer = setTimeout(() => {
	lines.close();
	process.stdin.destroy();
}, 45000);
try {
	const iterator = lines[Symbol.asyncIterator]();
	const first = await iterator.next();
	if (first.done || first.value.length > 32768)
		throw new Error("Invalid source lease request");
	const request = JSON.parse(first.value);
	const repository = new SessionRepository({
		rootDir: "/state/sessions",
		journalRoot: "/state/runs",
	});
	lease = ProjectSourceLease.acquire(repository, request.sessionIds);
	const captures = [];
	for (const id of request.sessionIds) captures.push(await lease.capture(id));
	const result = JSON.stringify({ captures });
	if (Buffer.byteLength(result) > 4 * 1024 * 1024)
		throw new Error("Source response too large");
	process.stdout.write(`${result}\n`);
	const release = await iterator.next();
	if (!release.done && release.value !== "release")
		throw new Error("Invalid lease release");
} catch (error) {
	process.stdout.write(`${JSON.stringify({ error: String(error) })}\n`);
	process.exitCode = 1;
} finally {
	clearTimeout(timer);
	try {
		lease?.close();
	} catch (error) {
		process.stderr.write(String(error));
		process.exitCode = 1;
	}
	lines.close();
	process.stdin.destroy();
}
