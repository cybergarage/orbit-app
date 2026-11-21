import assert from "node:assert/strict";
import { test } from "node:test";
import {
	admitWorkspaceReaderImage,
	dockerArgs,
	dockerPath,
	image,
	standaloneWorkspaceReaderImage,
	workerLaunchArgs,
} from "../src/worker";

const name = "synthetic-worker";
const workspace = "/synthetic/workspace";
const state = "/synthetic/state";
const admitted = `sha256:${"a".repeat(64)}`;
const replacement = `sha256:${"b".repeat(64)}`;

test("opt-in refuses old, missing and malformed Docker worker images", async () => {
	for (const inspect of [
		async () => `${admitted} \n`,
		async () => `${admitted} 0\n`,
		async () => `${admitted} 2\n`,
		async () => `--privileged 1\n`,
		async () => `${admitted} 1\n${replacement} 1\n`,
		async () => {
			throw new Error("Image not found");
		},
	]) {
		await assert.rejects(
			workerLaunchArgs(name, workspace, state, true, inspect),
			/require a compatible Docker worker image/,
		);
	}
});

test("opt-in uses the admitted immutable local image even if the tag moves", async () => {
	let taggedImage = admitted;
	let inspections = 0;
	const args = await workerLaunchArgs(
		name,
		workspace,
		state,
		true,
		async (executable, inspect, timeout) => {
			assert.equal(executable, dockerPath);
			assert.deepEqual(inspect.slice(0, 3), ["image", "inspect", "--format"]);
			assert.match(
				inspect[3],
				/org\.cybergarage\.orbit-app\.workspace-mutations/,
			);
			assert.equal(inspect[4], image);
			assert.equal(timeout, 5_000);
			inspections++;
			const snapshot = taggedImage;
			taggedImage = replacement;
			return `${snapshot} 1\n`;
		},
	);
	assert.equal(inspections, 1);
	assert.equal(taggedImage, replacement);
	assert.deepEqual(args, dockerArgs(name, workspace, state, admitted));
	assert.equal(args.at(-1), admitted);
	assert.ok(!args.includes(image));
	assert.ok(args.includes("--pull=never"));
});

test("default Docker worker launch is unchanged and never inspects a tag", async () => {
	const args = await workerLaunchArgs(
		name,
		workspace,
		state,
		false,
		async () => {
			assert.fail("Default launch must not inspect a worker image");
		},
	);
	assert.deepEqual(args, dockerArgs(name, workspace, state));
	assert.equal(args.at(-1), image);
});

test("Host reader accepts only its standalone capability and never probes legacy fallback", async () => {
	let calls = 0;
	const value = await admitWorkspaceReaderImage(async (exe, args) => {
		calls++;
		assert.equal(exe, dockerPath);
		assert.match(args[3], /workspace-reader-standalone/);
		assert.equal(args[4], standaloneWorkspaceReaderImage);
		return `${admitted} 1\n`;
	});
	assert.equal(value, admitted);
	assert.equal(calls, 1);
	for (const old of [`${admitted} <no value>\n`, `${admitted} 0\n`]) {
		let attempts = 0;
		await assert.rejects(
			admitWorkspaceReaderImage(async (_exe, args) => {
				attempts++;
				assert.equal(args[4], standaloneWorkspaceReaderImage);
				return old;
			}),
			/requires the standalone Docker reader/,
		);
		assert.equal(attempts, 1);
	}
});
