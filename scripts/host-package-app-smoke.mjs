import fs from "node:fs/promises";
import path from "node:path";
import { verifyPackagedHostDefault } from "./host-default-app-smoke.mjs";
import { verifyPackagedWorkspaceWrites } from "./host-file-changes-app-smoke.mjs";
import { verifyPackagedProfileTransition } from "./host-profile-transition-app-smoke.mjs";
import { verifyPackagedWorkspaceReadiness } from "./host-readiness-app-smoke.mjs";

/** Verify the ordinary arm64 App artifact in serial, disposable profiles. */
export async function verifyOrdinaryHostPackage(
	bundle,
	executable,
	scratch,
	root,
) {
	const [transition, approvals, readiness, defaults] = await Promise.all(
		["transition", "approvals", "readiness", "defaults"].map(async (name) => {
			const directory = path.join(scratch, name);
			await fs.mkdir(directory, { mode: 0o700 });
			return directory;
		}),
	);
	// These proofs reserve some of the same Docker tags and must not overlap.
	await verifyPackagedProfileTransition(executable, transition, root);
	await verifyPackagedWorkspaceWrites(executable, approvals, root);
	await verifyPackagedWorkspaceReadiness(executable, readiness, root);
	// The default proof intentionally removes only this disposable bundle's
	// native addon at the end, so it must be the final proof.
	await verifyPackagedHostDefault(bundle, executable, defaults, root);
	console.log("Ordinary macOS arm64 package verification passed.");
}
