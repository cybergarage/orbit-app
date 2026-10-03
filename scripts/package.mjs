import { packager } from "@electron/packager";
const paths = await packager({
	dir: ".",
	name: "Orbit App",
	platform: "darwin",
	arch: "arm64",
	out: "release",
	overwrite: true,
	prune: true,
	asar: true,
	appBundleId: "org.cybergarage.orbit-app",
	ignore: [
		/^\/(src|test|scripts|release|test-results|worker|\.git)(\/|$)/,
		/^\/(tsconfig|biome|playwright)/,
	],
	extraResource: ["worker"],
});
console.log(paths.join("\n"));
