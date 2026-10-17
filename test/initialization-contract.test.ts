import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { command, dockerPath, image, workerUserArgs } from "../src/worker";

test("published initialization APIs preserve registered container paths and reject host aliases", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-init-contract-"));
	try {
		const result = await command(
			dockerPath,
			[
				"run",
				"--rm",
				"--pull=never",
				"--network",
				"none",
				"--read-only",
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges",
				"--tmpfs",
				"/tmp:rw,noexec,nosuid,size=256m",
				"--name",
				`orbit-init-contract-${randomUUID()}`,
				"--mount",
				`type=bind,src=${root},dst=/state`,
				"--mount",
				`type=bind,src=${root},dst=/host-core`,
				...workerUserArgs(),
				"--workdir",
				"/opt/worker",
				"--entrypoint",
				"node",
				image,
				"--input-type=module",
				"-e",
				`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SessionRepository, planInitialization, executeInitialization } from '@cybergarage/orbit';
assert.equal(typeof planInitialization, 'function');
assert.equal(typeof executeInitialization, 'function');
const repository = new SessionRepository({rootDir:'/state/sessions', journalRoot:'/state/runs'});
repository.initializeStorage({allWritersStopped:true,automaticRestartersDisabled:true,exclusiveStorageControl:true});
const profile = root => ({cacheRoots:[],ownedRoots:[root],preservedPaths:[],scheduledRoots:[],settingsFiles:[],stores:[{sessionRoot:root+'/sessions',journalRoot:root+'/runs',logRoot:root+'/logs',projectFile:root+'/projects.sqlite'}]});
const before=fs.readFileSync('/state/sessions/.orbit-session-binding.json','utf8');
const plan=planInitialization(profile('/state'),'data');
assert.ok(plan.targets.some(t=>t.path==='/state/sessions'));
assert.throws(()=>planInitialization(profile('/host-core'),'data'),/Conflicting storage partner blocks reset/);
assert.equal(fs.readFileSync('/state/sessions/.orbit-session-binding.json','utf8'),before);
console.log('published exports verified; registered namespace accepted; host alias refused; no deletion');
`,
			],
			30000,
		);
		assert.match(result, /host alias refused; no deletion/);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
