/**
 * Integration tests against the real Codex app-server and the signed-in Codex account.
 * Requires `codex login` (ChatGPT) with at least one connected app that exposes a read-only
 * profile tool (GitHub, Gmail, Google Calendar/Drive, Figma, Slack).
 * No model turns run: every call goes straight to the connector.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { CodexConnectors, type ConnectorTool } from "../src/connectors.ts";

const PROFILE_TOOLS = [
	"github.get_profile",
	"gmail.get_profile",
	"google_calendar.get_profile",
	"google_drive.get_profile",
	"figma.whoami",
];

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe("Codex connectors through the Codex app-server", () => {
	const connectors = new CodexConnectors();
	let profileTool: ConnectorTool;

	before(async () => {
		const all = await connectors.connectors();
		const tools = all.flatMap((connector) => connector.tools);
		const found = PROFILE_TOOLS.map((name) => tools.find((tool) => tool.name === name)).find(Boolean);
		assert.ok(found, `none of ${PROFILE_TOOLS.join(", ")} is connected`);
		profileTool = found;
	});

	after(async () => {
		await connectors.close();
	});

	it("lists only the account's connected apps, each with its own tools", async () => {
		const all = await connectors.connectors();
		assert.ok(all.length > 0, "expected at least one connected app");
		for (const connector of all) {
			for (const tool of connector.tools) {
				assert.equal(tool.connectorId, connector.id);
				assert.equal(tool.inputSchema.type, "object", `${tool.name} has no object input schema`);
			}
		}
		const names = all.flatMap((connector) => connector.tools.map((tool) => tool.name));
		assert.equal(new Set(names).size, names.length, "tool names must be unique");
		assert.ok(names.every((name) => name.includes(".")), "only codex_apps tools (prefix.tool) are exposed");
	});

	it("marks read-only tools from their MCP annotations", async () => {
		const tools = (await connectors.connectors()).flatMap((connector) => connector.tools);
		assert.equal(profileTool.readOnly, true);
		assert.ok(tools.some((tool) => !tool.readOnly), "expected at least one tool that writes");
	});

	it("calls a read-only connector tool and returns its structured result", async () => {
		const result = await connectors.call(profileTool.name, {});
		assert.equal(result.isError, false, JSON.stringify(result));
		const payload = JSON.stringify([result.content, result.structuredContent]);
		assert.ok(payload.length > 20, `unexpectedly empty result: ${payload}`);
	});

	it("rejects tools outside the connected catalog without calling Codex", async () => {
		await assert.rejects(connectors.call("github.definitely_not_a_tool", {}), /Unknown Codex connector tool/);
	});

	it("honours an already aborted signal", async () => {
		await assert.rejects(connectors.call(profileTool.name, {}, AbortSignal.abort()), /aborted/);
	});

	it("starts a fresh app-server after the previous one dies", async () => {
		const first = await connectors.pid();
		assert.ok(first);
		process.kill(first, "SIGKILL");
		await waitFor(() => !isRunning(first));
		const result = await connectors.call(profileTool.name, {});
		assert.equal(result.isError, false);
		const second = await connectors.pid();
		assert.ok(second && second !== first, "expected a new app-server process");
	});

	it("refresh reloads the catalog on a new app-server", async () => {
		const before = await connectors.pid();
		const all = await connectors.refresh();
		assert.ok(all.length > 0);
		assert.notEqual(await connectors.pid(), before);
		assert.ok(before && !isRunning(before), "old app-server must be stopped");
	});

	it("close stops the app-server and rejects later use", async () => {
		const service = new CodexConnectors();
		await service.connectors();
		const pid = await service.pid();
		assert.ok(pid && isRunning(pid));
		await service.close();
		await waitFor(() => !isRunning(pid));
		await assert.rejects(service.connectors(), /closed/);
	});

	it("reports a missing Codex executable", async () => {
		const service = new CodexConnectors({ command: "/nonexistent/codex" });
		await assert.rejects(service.connectors(), /failed to start|ENOENT/);
		await service.close();
	});
});
