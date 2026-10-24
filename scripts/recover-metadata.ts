import path from "node:path";
import { ContainerCoreNames } from "../src/core-names";
const root = process.argv[2];
if (!root || process.argv.length !== 3)
	throw new Error("Usage: npm run metadata:recover -- <App profile>");
await ContainerCoreNames.recover(path.resolve(root));
console.log("Verified owned metadata helper absence; profile may be reopened.");
