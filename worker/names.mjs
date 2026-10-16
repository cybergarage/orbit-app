import { createInterface } from "node:readline";
import {
	ProjectService,
	SessionRepository,
	SqliteProjectStore,
	sessionDisplayName,
} from "@cybergarage/orbit";

// Host supplies IDs already authorized against its project/session registry.
// This helper receives only the catalog and one original core directory.
export async function names(
	request,
	catalogFile = "/catalog/projects.sqlite",
	coreRoot = "/state",
) {
	const repository = new SessionRepository({
		rootDir: `${coreRoot}/sessions`,
		journalRoot: `${coreRoot}/runs`,
	});
	const catalog = await SqliteProjectStore.open({ file: catalogFile });
	const projects = new ProjectService(
		catalog,
		repository,
		{ getThread: () => undefined, closeThread: async () => {} },
		"/workspace",
	);
	try {
		switch (request.command) {
			case "create-project":
				return await projects.create({
					name: request.name,
					operationId: request.projectId,
				});
			case "read-project": {
				const project = await catalog.query({
					kind: "project",
					id: request.projectId,
				});
				if (!project)
					throw new Error("Core project not found; refresh before editing");
				return project;
			}
			case "rename-project":
				return await projects.rename(request.projectId, {
					name: request.name,
					expectedRevision: request.expectedRevision,
					operationId: request.operationId,
				});
			case "create-session": {
				if (repository.inspectStorage().state === "unregistered")
					repository.initializeStorage({
						allWritersStopped: true,
						automaticRestartersDisabled: true,
						exclusiveStorageControl: true,
					});
				if (await repository.findById(request.sessionId))
					throw new Error("Core session already exists");
				const session = repository.create({
					id: request.sessionId,
					cwd: "/workspace",
					provider: "ollama",
					formatVersion: 3,
					originator: "orbit-app",
				});
				await session.synchronize("file-and-directory-sync");
				await session.close();
				return { revision: 0 };
			}
			case "read-sessions": {
				const sessions = repository.list();
				return request.sessionIds.map((id) => {
					const session = sessions.find((item) => item.id === id);
					if (!session) throw new Error(`Core session not found: ${id}`);
					return {
						id,
						name: sessionDisplayName(session),
						revision: session.titleRevision,
					};
				});
			}
			case "rename-session": {
				const session = await repository.rename(request.sessionId, {
					title: request.name,
					expectedRevision: request.expectedRevision,
					operationId: request.operationId,
				});
				return {
					name: sessionDisplayName(session),
					revision: session.titleRevision,
				};
			}
			default:
				throw new Error("Unknown core metadata operation");
		}
	} finally {
		await catalog.close();
	}
}

if (process.argv[1]?.endsWith("/names.mjs")) {
	const lines = createInterface({ input: process.stdin });
	const { value: line, done } = await lines[Symbol.asyncIterator]().next();
	if (!done) {
		try {
			process.stdout.write(
				`${JSON.stringify({ result: await names(JSON.parse(line)) })}\n`,
			);
		} catch (error) {
			process.stdout.write(
				`${JSON.stringify({ error: String(error), code: error.code })}\n`,
			);
			process.exitCode = 1;
		}
	}
	lines.close();
}
