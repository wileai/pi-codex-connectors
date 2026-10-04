/** User policy persistence with synthetic files and a non-networked connector fixture. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it, mock } from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { CodexConnectors, type CodexConnectorsOptions, type ConnectorTool } from "../src/connectors.ts";
import { permissionPolicy, savePermissions } from "../src/permissions.ts";

const variables = ["PI_CODING_AGENT_DIR", "PI_CODEX_CONNECTORS_DATA", "PI_CODEX_WEB_SEARCH_DATA", "PI_CODEX_CONNECTORS_WRITES"];
let original: Array<string | undefined>;
let directory: string;
beforeEach(() => {
	original = variables.map((key) => process.env[key]);
	for (const key of variables) delete process.env[key];
	directory = mkdtempSync(join(tmpdir(), "pi-permissions-test-"));
	process.env.PI_CODING_AGENT_DIR = directory;
});
afterEach(() => {
	mock.restoreAll();
	variables.forEach((key, index) => {
		if (original[index] === undefined) delete process.env[key]; else process.env[key] = original[index];
	});
	rmSync(directory, { recursive: true, force: true });
});

it("stores only policies with private file permissions and survives a new process", () => {
	savePermissions({ connectors: "allow", web: "allow", writes: "allow" });
	const file = join(directory, "codex-connectors-permissions.json");
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { connectors: "allow", web: "allow", writes: "allow" });
	if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
	const module = new URL("../src/permissions.ts", import.meta.url).href;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e",
		`import {permissionPolicy} from ${JSON.stringify(module)}; console.log(['connectors','web','writes'].map(permissionPolicy).join(','));`],
		{ env: process.env, encoding: "utf8" });
	assert.equal(result.status, 0, "new process could not read saved policies; diagnostics withheld");
	assert.ok(result.stdout.trim() === "allow,allow,allow", "permissions did not survive process restart");
});

it("environment overrides saved preferences and changes never authorize other scopes", () => {
	savePermissions({ web: "allow" });
	assert.equal(permissionPolicy("connectors"), "ask");
	assert.equal(permissionPolicy("writes"), "ask");
	assert.equal(permissionPolicy("web"), "allow");
	process.env.PI_CODEX_WEB_SEARCH_DATA = "deny";
	assert.equal(permissionPolicy("web"), "deny");
	process.env.PI_CODEX_WEB_SEARCH_DATA = "ask";
	assert.equal(permissionPolicy("web"), "ask");
	process.env.PI_CODEX_WEB_SEARCH_DATA = "invalid";
	assert.equal(permissionPolicy("web"), "ask");
	delete process.env.PI_CODEX_WEB_SEARCH_DATA;
	savePermissions({ writes: "allow" });
	assert.equal(permissionPolicy("web"), "allow");
	savePermissions({ web: "deny", writes: "ask" });
	assert.equal(permissionPolicy("web"), "deny");
	assert.equal(permissionPolicy("writes"), "ask");
});

it("malformed saved preferences fail closed without exposing file contents or paths", () => {
	for (const content of ["SYNTHETIC_PRIVATE_VALUE", '{"web":"invalid"}', '{"unknown":"allow"}', '[]']) {
		writeFileSync(join(directory, "codex-connectors-permissions.json"), content);
		assert.throws(() => permissionPolicy("web"), (error: Error) => {
			assert.ok(/Could not read saved Codex permissions/.test(error.message));
			assert.ok(!error.message.includes("SYNTHETIC") && !error.message.includes(directory));
			return true;
		});
	}
});

it("saved all-allow skips both connector-data and write confirmations; revoke blocks the next call", async () => {
	savePermissions({ connectors: "allow", web: "allow", writes: "allow" });
	const tools: ToolDefinition[] = [];
	extension({ registerTool: (tool: ToolDefinition) => tools.push(tool), registerCommand() {}, on() {} } as unknown as ExtensionAPI);
	const descriptor: ConnectorTool = { name: "synthetic.write", title: "Synthetic", description: "Test only",
		connectorId: "synthetic", connectorName: "Synthetic", inputSchema: {}, readOnly: false, destructive: false };
	mock.method(CodexConnectors.prototype, "tool", async () => descriptor);
	const call = mock.method(CodexConnectors.prototype, "call", async function (this: unknown) {
		// Simulate a connector asking for confirmation after dispatch, without running a real write.
		const { options } = this as { options: CodexConnectorsOptions };
		const answer = await options.onElicitation!({ serverName: "synthetic", mode: "form", message: "Confirm synthetic action", requestedSchema: { type: "object", properties: {} } });
		assert.equal(answer.action, "accept", "saved allow did not cover the connector confirmation");
		const input = await options.onElicitation!({ serverName: "synthetic", mode: "form", message: "Synthetic required input", requestedSchema: { type: "object", properties: { value: { type: "string" } } } });
		assert.equal(input.action, "decline", "saved permission must not fabricate required input");
		return { content: [{ type: "text", text: "ok" }], isError: false };
	});
	const confirm = mock.fn(() => { throw new Error("Unexpected confirmation"); });
	const ctx = { hasUI: false, ui: { confirm } } as unknown as ExtensionToolContext;
	const tool = tools.find((tool) => tool.name === "codex_connector_call")!;
	await tool.execute("test", { tool: descriptor.name, arguments: {} }, undefined, undefined, ctx);
	assert.equal(confirm.mock.callCount(), 0);
	assert.equal(call.mock.callCount(), 1);
	savePermissions({ writes: "deny" });
	await assert.rejects(tool.execute("test", { tool: descriptor.name, arguments: {} }, undefined, undefined, ctx), /blocked/);
	assert.equal(call.mock.callCount(), 1, "revoked write still reached the connector");
	savePermissions({ writes: "allow", connectors: "deny" });
	await assert.rejects(tool.execute("test", { tool: descriptor.name, arguments: {} }, undefined, undefined, ctx), /data access denied/);
	assert.equal(call.mock.callCount(), 1, "revoked data access still reached the connector");
});
