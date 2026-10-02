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
	message?: { role?: string; content?: Array<{ type: string; text?: string }> };
}

async function run(script: string) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-connector-rpc-"));
	const child = spawn(process.env.PI_BIN ?? "pi", [
		"--mode", "rpc", "--no-session", "--no-extensions", "--no-skills",
		"--no-prompt-templates", "--no-context-files", "--model", "scripted/connectors",
		"--extension", fileURLToPath(new URL("../src/index.ts", import.meta.url)),
		"--extension", fileURLToPath(new URL("./fixtures/scripted-model.ts", import.meta.url)),
	], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: cwd, PI_TELEMETRY: "0",
		PI_CODEX_CONNECTORS_DATA: "ask", PI_CODEX_CONNECTORS_WRITES: "ask",
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
			if (event.type === "extension_ui_request" && event.method === "confirm") {
				dialogs.push(event.title ?? "");
				child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: event.id,
					confirmed: event.title?.startsWith("Share connector data") === true }) + "\n");
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
		child.stdin.write(JSON.stringify({ type: "prompt", message: "Exercise connector approval." }) + "\n");
		assert.equal(await completion, 0, "Pi exited unsuccessfully; diagnostics withheld");
		assert.ok(!invalidOutput, "Pi returned invalid JSON; output withheld");
		return { dialogs, text: texts.join("\n") };
	} finally {
		clearTimeout(timer);
		rmSync(cwd, { recursive: true, force: true });
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
