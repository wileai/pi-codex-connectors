/** Real Pi RPC UI + real Codex discovery; every write is rejected before dispatch. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

interface Event {
	type: string;
	id?: string;
	method?: string;
	title?: string;
	success?: boolean;
	message?: { role?: string; content?: Array<{ type: string; text?: string }> };
}

async function run(script: string, options: { command?: string; agentDir?: string; saved?: boolean; acceptWeb?: boolean; noCodex?: boolean } = {}) {
	const cwd = options.agentDir ?? mkdtempSync(join(tmpdir(), "pi-connector-rpc-"));
	const child = spawn(process.env.PI_BIN ?? "pi", [
		"--mode", "rpc", "--no-session", "--no-extensions", "--no-skills",
		"--no-prompt-templates", "--no-context-files", "--model", "scripted/connectors",
		"--extension", fileURLToPath(new URL("../src/index.ts", import.meta.url)),
		"--extension", fileURLToPath(new URL("./fixtures/scripted-model.ts", import.meta.url)),
	], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: cwd, PI_TELEMETRY: "0",
		PI_CODEX_CONNECTORS_DATA: options.saved ? undefined : "ask", PI_CODEX_CONNECTORS_WRITES: options.saved ? undefined : "ask",
		PI_CODEX_WEB_SEARCH_DATA: options.saved ? undefined : "ask", PI_CODEX_WEB_SEARCH_MODE: "cached",
		...(options.noCodex ? { PI_CODEX_CONNECTORS_CODEX: "/nonexistent-codex" } : {}),
		PI_CODEX_CONNECTORS_ALLOW: "GitHub", PI_CODEX_SCRIPT: script }, stdio: ["pipe", "pipe", "pipe"] });
	const dialogs: string[] = [];
	const texts: string[] = [];
	let buffer = "";
	let invalidOutput = false;
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		let newline: number;
		while ((newline = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
			if (!line.trim()) continue;
			let event: Event;
			try { event = JSON.parse(line) as Event; } catch { invalidOutput = true; child.kill("SIGTERM"); return; }
			if (event.type === "response" && event.id === "initial-command") {
				if (!event.success) { invalidOutput = true; child.kill("SIGTERM"); return; }
				child.stdin.write(JSON.stringify({ type: "prompt", message: "Exercise web search policy." }) + "\n");
			}
			if (event.type === "extension_ui_request" && event.method === "confirm") {
				dialogs.push(event.title ?? "");
				child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: event.id,
					confirmed: event.title?.startsWith("Always allow connector data") === true ||
						(options.acceptWeb === true && event.title?.startsWith("Always allow web search") === true) }) + "\n");
			}
			if (event.type === "message_end") {
				for (const block of event.message?.content ?? []) if (block.type === "text" && block.text) texts.push(block.text);
			}
			if (event.type === "agent_end") child.stdin.end();
		}
	});
	child.stderr.resume();
	const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
	try {
		const completion = new Promise<number | null>((resolve, reject) => { child.on("close", resolve); child.on("error", () => reject(new Error("Pi process failed to start; diagnostics withheld"))); });
		child.stdin.write(JSON.stringify({ type: "prompt", ...(options.command ? { id: "initial-command" } : {}),
			message: options.command ?? "Exercise connector approval." }) + "\n");
		assert.equal(await completion, 0, "Pi exited unsuccessfully; diagnostics withheld");
		assert.ok(!invalidOutput, "Pi returned invalid JSON; output withheld");
		return { dialogs, text: texts.join("\n") };
	} finally {
		clearTimeout(timer);
		if (!options.agentDir) rmSync(cwd, { recursive: true, force: true });
	}
}

it("real Pi UI rejects oversized arguments without offering a truncated approval", async () => {
	const result = await run("write-long");
	assert.equal(result.dialogs.length, 1, "only the data consent dialog should be offered");
	assert.ok(/Write arguments exceed the safe approval display limit/.test(result.text), "missing oversized-write denial");
});

it("real Pi UI honors a declined write after accepting data consent", async () => {
	const result = await run("write");
	assert.equal(result.dialogs.length, 2);
	assert.ok(/^Allow GitHub:/.test(result.dialogs[1]!), "missing GitHub write dialog");
	assert.ok(/The user declined/.test(result.text), "missing declined-write denial");
});

it("web search policy honors declined consent in the real Pi UI", async () => {
	const result = await run("web-policy");
	assert.deepEqual(result.dialogs, ["Always allow web search for this Pi user?"]);
	assert.ok(/Web search access declined/.test(result.text), "missing declined-search denial");
});

it("web search policy can be disabled by the real Pi user command", async () => {
	const result = await run("web-policy", { command: "/codex-web-search disabled" });
	assert.equal(result.dialogs.length, 0);
	assert.ok(/web search is disabled/.test(result.text), "user command did not disable search");
});

it("web search policy saves all permissions across processes and supports immediate revocation", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-saved-permissions-"));
	try {
		const options = { agentDir, saved: true, noCodex: true };
		const allowed = await run("web-policy", { ...options, command: "/codex-permissions all allow" });
		assert.equal(allowed.dialogs.length, 0);
		assert.ok(/private diagnostics were withheld/.test(allowed.text), "saved approval did not reach auth");
		const restarted = await run("web-policy", options);
		assert.equal(restarted.dialogs.length, 0);
		assert.ok(/private diagnostics were withheld/.test(restarted.text), "saved approval did not survive restart");
		const denied = await run("web-policy", { ...options, command: "/codex-permissions all deny" });
		assert.equal(denied.dialogs.length, 0);
		assert.ok(/data access denied/.test(denied.text), "saved deny did not take effect");
		const ask = await run("web-policy", { ...options, command: "/codex-permissions web ask" });
		assert.equal(ask.dialogs.length, 1, "ask must restore the approval prompt");
	} finally { rmSync(agentDir, { recursive: true, force: true }); }
});

it("web search policy remembers UI consent across restart and mode changes", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-web-consent-"));
	try {
		const options = { agentDir, saved: true, noCodex: true };
		const first = await run("web-policy", { ...options, acceptWeb: true });
		assert.equal(first.dialogs.length, 1);
		const next = await run("web-policy", { ...options, command: "/codex-web-search live" });
		assert.equal(next.dialogs.length, 0);
		assert.ok(/private diagnostics were withheld/.test(next.text), "saved UI approval did not reach auth after restart");
	} finally { rmSync(agentDir, { recursive: true, force: true }); }
});
