import { build } from "esbuild";
import fs from "node:fs/promises";
await fs.mkdir("dist", { recursive: true });
await build({
	entryPoints: ["src/main.ts"],
	bundle: true,
	platform: "node",
	format: "cjs",
	external: ["electron"],
	outfile: "dist/main.cjs",
});
await build({
	entryPoints: ["src/preload.ts"],
	bundle: true,
	platform: "node",
	format: "cjs",
	external: ["electron"],
	outfile: "dist/preload.cjs",
});
await build({
	entryPoints: ["src/ui.tsx"],
	bundle: true,
	platform: "browser",
	format: "iife",
	outfile: "dist/ui.js",
	loader: { ".css": "css" },
});
await fs.copyFile("src/index.html", "dist/index.html");
