import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
assert.equal(pkg.name, "pi-codex-connectors");
assert.ok(pkg.keywords.includes("pi-package"));
assert.deepEqual(pkg.pi.extensions, ["./src/index.ts"]);
const tag = process.env.RELEASE_TAG;
if (tag) {
	assert.equal(tag, `v${pkg.version}`, "Release tag must match package.json version");
	assert.equal(pkg.version.includes("-"), process.env.RELEASE_PRERELEASE === "true",
		"Prerelease version and GitHub prerelease flag must agree");
}
const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" }));
const expected = ["LICENSE", "README.md", "package.json", "src/app-server.ts", "src/connectors.ts", "src/index.ts", "src/output.ts"];
assert.deepEqual(pack.files.map(file => file.path).sort(), expected.sort(), "Review unexpected or missing package files");
assert.equal(pack.bundled.length, 0);
console.log(`Verified ${pkg.name}@${pkg.version}: ${pack.files.length} public package files`);
