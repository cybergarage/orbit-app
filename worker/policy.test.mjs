import { test } from "node:test";
import assert from "node:assert/strict";
import { safePatterns, decideOperation } from "./policy.mjs";
test("ordinary glob patterns retain normal matching; suspicious deep/long/wide patterns fail closed", () => {
	assert.ok(safePatterns(["**/*.ts", "src/main?.ts"]));
	assert.ok(safePatterns(undefined));
	assert.equal(safePatterns("{1..999999999}"), false);
	assert.equal(safePatterns("{a,b}".repeat(32)), false);
	assert.equal(safePatterns("+(a|b)"), false);
	assert.equal(safePatterns(`${"{".repeat(33)}a${"}".repeat(33)}`), false);
	assert.equal(safePatterns("a".repeat(2049)), false);
	assert.equal(safePatterns(Array(17).fill("*.ts")), false);
});
test("read glob/grep attacks are denied before execution; writes and commands still require approval", () => {
	assert.equal(
		decideOperation({
			name: "glob",
			effect: "read",
			input: { pattern: "{".repeat(33) },
		}),
		"deny",
	);
	assert.equal(
		decideOperation({
			name: "grep",
			effect: "read",
			input: { glob: "{".repeat(33) },
		}),
		"deny",
	);
	assert.equal(
		decideOperation({
			name: "glob",
			effect: "read",
			input: { pattern: "**/*" },
		}),
		"allow",
	);
	assert.equal(
		decideOperation({
			name: "bash",
			effect: "command",
			input: { command: "node test.cjs" },
		}),
		"ask",
	);
	assert.equal(
		decideOperation({ name: "edit", effect: "write", input: {} }),
		"ask",
	);
});
