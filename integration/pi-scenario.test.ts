/**
 * Scenario tests: the real pi CLI loads the extension and a scripted model
 * (fixtures/scripted-model.ts), then talks to the real Codex app-server and connectors.
 * No model tokens are spent. Requires `pi` (or PI_BIN) and `codex login` with GitHub connected.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extension = join(root, "src", "index.ts");
const scriptedModel = join(root, "integration", "fixtures", "scripted-model.ts");
const agentDir = mkdtempSync(join(tmpdir(), "pi-codex-connectors-agent-"));

type PiEvent = {
	type: string;
	message?: {
		role: string;
		toolName?: string;
		isError?: boolean;
		content: string | Array<{ type: string; text?: string }>;
	};
};

interface PiRun {
	code: number | null;
	stderr: string;
	events: PiEvent[];
	/** app-server processes seen while pi was running that were not running before. */
	appServers: number[];
}

function appServerPids(): Set<number> {
	try {
		const out = execFileSync("pgrep", ["-f", "app-server --listen stdio://"], { encoding: "utf8" });
		return new Set(out.split("\n").filter(Boolean).map(Number));
	} catch {
		return new Set();
	}
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function textOf(message: NonNullable<PiEvent["message"]>): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map((block) => block.text ?? "").join("");
}

function runPi(script: string, env: Record<string, string> = {}): Promise<PiRun> {
	const before = appServerPids();
	const child = spawn(
		process.env.PI_BIN ?? "pi",
		[
			"--mode",
			"json",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--extension",
			extension,
			"--extension",
			scriptedModel,
			"--model",
			"scripted/connectors",
			"-p",
			"Use my Codex connectors.",
		],
		{
			cwd: agentDir,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_TELEMETRY: "0", PI_CODEX_CONNECTORS_DATA: "allow", PI_CODEX_SCRIPT: script, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const events: PiEvent[] = [];
	const seen = new Set<number>();
	let buffer = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			if (line.trim()) {
				const event = JSON.parse(line) as PiEvent;
				events.push(event);
				if (event.type === "message_end" && event.message?.role === "toolResult") {
					for (const pid of appServerPids()) if (!before.has(pid)) seen.add(pid);
				}
			}
			newline = buffer.indexOf("\n");
		}
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
	return new Promise((resolve) => {
		child.on("close", (code) => {
			clearTimeout(timeout);
			resolve({ code, stderr, events, appServers: [...seen] });
		});
	});
}

function toolResults(run: PiRun) {
	return run.events
		.filter((event) => event.type === "message_end" && event.message?.role === "toolResult")
		.map((event) => ({ tool: event.message?.toolName, isError: event.message?.isError, text: textOf(event.message!) }));
}

function finalText(run: PiRun): string {
	const assistant = run.events.filter((event) => event.type === "message_end" && event.message?.role === "assistant");
	const last = assistant.at(-1)?.message;
	return last ? textOf(last) : "";
}

async function assertNoLeftoverAppServers(run: PiRun) {
	const deadline = Date.now() + 5000;
	while (run.appServers.some(isRunning) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.deepEqual(run.appServers.filter(isRunning), [], "pi left a Codex app-server running");
}

describe("pi CLI with the Codex connectors extension", () => {
	after(() => rmSync(agentDir, { recursive: true, force: true }));

	it("discovers connectors, reads a schema, and calls GitHub through Codex", async () => {
		const run = await runPi("read");
		assert.equal(run.code, 0, run.stderr);
		const results = toolResults(run);
		assert.deepEqual(
			results.map((result) => [result.tool, result.isError]),
			[
				["codex_connectors", false],
				["codex_connectors", false],
				["codex_connector_schema", false],
				["codex_connector_call", false],
			],
			JSON.stringify(results, null, 2),
		);
		assert.match(results[0]!.text, /Connected Codex connectors \(\d+\)/);
		assert.match(results[2]!.text, /Input schema:/);
		assert.match(finalText(run), /^SCRIPT_OK github user \S+/);
		assert.ok(run.appServers.length > 0, "expected pi to start a Codex app-server");
		await assertNoLeftoverAppServers(run);
	});

	it("blocks a writing tool when no UI can approve it", async () => {
		const run = await runPi("write");
		assert.equal(run.code, 0, run.stderr);
		assert.match(finalText(run), /^SCRIPT_BLOCKED .*no UI is available to approve it/s);
		await assertNoLeftoverAppServers(run);
	});

	it("blocks a writing tool when PI_CODEX_CONNECTORS_WRITES=deny", async () => {
		const run = await runPi("write", { PI_CODEX_CONNECTORS_WRITES: "deny" });
		assert.equal(run.code, 0, run.stderr);
		assert.match(finalText(run), /^SCRIPT_BLOCKED .*blocked by PI_CODEX_CONNECTORS_WRITES=deny/s);
	});

	it("requires data consent before discovery in headless mode", async () => {
		const run = await runPi("read", { PI_CODEX_CONNECTORS_DATA: "ask" });
		const results = toolResults(run);
		assert.equal(results[0]?.isError, true);
		assert.match(results[0]!.text, /Connector data needs consent/);
		assert.equal(run.appServers.length, 0);
	});

	it("denies discovery when data sharing is disabled", async () => {
		const run = await runPi("read", { PI_CODEX_CONNECTORS_DATA: "deny" });
		assert.match(toolResults(run)[0]!.text, /data access denied/);
		assert.equal(run.appServers.length, 0);
	});

	it("an empty connector allowlist exposes no apps", async () => {
		const run = await runPi("read", { PI_CODEX_CONNECTORS_ALLOW: "" });
		assert.match(toolResults(run)[0]!.text, /No Codex connectors/);
		await assertNoLeftoverAppServers(run);
	});

	it("rejects a tool that is not in the connected catalog", async () => {
		const run = await runPi("unknown");
		assert.equal(run.code, 0, run.stderr);
		assert.match(finalText(run), /^SCRIPT_REJECTED .*Unknown Codex connector tool "github.no_such_tool"/s);
	});
});
