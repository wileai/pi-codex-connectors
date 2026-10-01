import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
const host = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const hostRequire = createRequire(host);
const minimatch = hostRequire.resolve("minimatch");
const braceRequire = createRequire(minimatch);
const file = braceRequire.resolve("brace-expansion/package.json");
const { version } = JSON.parse(readFileSync(file, "utf8"));
const [major, minor, patch] = version.split(".").map(Number);
if (major !== 5 || minor !== 0 || patch < 12) {
	throw new Error(`Unverified brace-expansion ${version} in the development Pi host. Run make setup.`);
}
console.log(`Actual development host brace-expansion: ${version}`);
