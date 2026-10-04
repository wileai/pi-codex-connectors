/**
 * Scenario tests: the real pi CLI loads the extension and a scripted model
 * (fixtures/scripted-model.ts), then talks to the real Codex app-server and connectors.
 * No model tokens are spent. Requires `pi` (or PI_BIN) and `codex login` with GitHub connected.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	invalidOutput: boolean;
	events: PiEvent[];
	/** app-server processes seen while pi was running that were not running before. */
	appServers: number[];
}

function appServerPids(rootPid: number): Set<number> {
	try {
		const out = execFileSync("pgrep", ["-f", "app-server --listen stdio://"], { encoding: "utf8" });
		const parents = new Map(execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
			.trim().split("\n").map((line) => {
				const [pid, parent] = line.trim().split(/\s+/).map(Number);
				return [pid!, parent!] as const;
			}));
		return new Set(out.split("\n").filter(Boolean).map(Number).filter((pid) => {
			const visited = new Set<number>();
			for (let parent = parents.get(pid); parent && !visited.has(parent); parent = parents.get(parent)) {
				if (parent === rootPid) return true;
				visited.add(parent);
			}
			return false;
		}));
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
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_TELEMETRY: "0", PI_CODEX_CONNECTORS_DATA: "allow", PI_CODEX_CONNECTORS_WRITES: "ask", PI_CODEX_CONNECTORS_ALLOW: "GitHub", PI_CODEX_SCRIPT: script, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const events: PiEvent[] = [];
	const seen = new Set<number>();
	let buffer = "";
	let invalidOutput = false;
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			if (line.trim()) {
				let event: PiEvent;
				try { event = JSON.parse(line) as PiEvent; } catch { invalidOutput = true; child.kill("SIGTERM"); return; }
				events.push(event);
				if (event.type === "message_end" && event.message?.role === "toolResult") {
					// Other Codex sessions may start app-servers concurrently; only track this Pi process.
					for (const pid of appServerPids(child.pid!)) seen.add(pid);
				}
			}
			newline = buffer.indexOf("\n");
		}
	});
	child.stderr.resume();
	const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
	return new Promise((resolve, reject) => {
		child.on("error", () => { clearTimeout(timeout); reject(new Error("Pi process failed to start; diagnostics withheld")); });
		child.on("close", (code) => {
			clearTimeout(timeout);
			resolve({ code, invalidOutput, events, appServers: [...seen] });
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

	for (const [policy, extra, expected] of [
		["headless consent", { PI_CODEX_WEB_SEARCH_DATA: "ask" }, /Web search needs consent/],
		["data denied", { PI_CODEX_WEB_SEARCH_DATA: "deny" }, /data access denied/],
		["disabled", { PI_CODEX_WEB_SEARCH_MODE: "disabled" }, /web search is disabled/],
		["invalid mode", { PI_CODEX_WEB_SEARCH_MODE: "fullfreedom" }, /Invalid web search mode/],
		["broader access", { PI_WEB_TEST_BROADER: "1" }, /exceeds the user-selected cached mode/],
	] as const) {
		it(`web search policy blocks ${policy} in the real Pi host`, async () => {
			const run = await runPi("web-policy", {
				PI_CODEX_WEB_SEARCH_DATA: "allow", PI_CODEX_WEB_SEARCH_MODE: "cached",
				PI_CODEX_CONNECTORS_CODEX: "/nonexistent-codex", ...extra,
			});
			assert.equal(run.code, 0, "Pi exited unsuccessfully; diagnostics withheld");
			assert.ok(!run.invalidOutput, "Pi returned invalid JSON; output withheld");
			assert.ok(finalText(run) === "SCRIPT_WEB_BLOCKED", "web policy scenario failed");
			assert.ok(expected.test(toolResults(run)[0]?.text ?? ""), "missing expected web policy error");
			assert.equal(run.appServers.length, 0);
		});
	}

	it("standalone web retrieval searches and opens a result through the real Pi host", async () => {
		const run = await runPi("web", { PI_CODEX_WEB_SEARCH_DATA: "allow", PI_CODEX_WEB_SEARCH_MODE: "indexed" });
		assert.equal(run.code, 0, "Pi exited unsuccessfully; diagnostics withheld");
		assert.ok(!run.invalidOutput, "Pi returned invalid JSON; output withheld");
		assert.ok(finalText(run) === "SCRIPT_WEB_OK", "Pi web retrieval scenario failed; response withheld");
		assert.deepEqual(toolResults(run).map((result) => [result.tool, result.isError]), [
			["codex_web_search", false], ["codex_web_search", false],
		]);
		await assertNoLeftoverAppServers(run);
	});

	it("discovers connectors, reads a schema, and calls GitHub through Codex", async () => {
		const run = await runPi("read");
		assert.equal(run.code, 0, "Pi exited unsuccessfully; diagnostics withheld");
		assert.ok(!run.invalidOutput, "Pi returned invalid JSON; output withheld");
		const results = toolResults(run);
		assert.deepEqual(
			results.map((result) => [result.tool, result.isError]),
			[
				["codex_connectors", false],
				["codex_connectors", false],
				["codex_connector_schema", false],
				["codex_connector_call", false],
			],
			"unexpected tool sequence; response content withheld",
		);
		assert.ok(/Connected Codex connectors \(\d+\)/.test(results[0]!.text), "connector listing missing");
		assert.ok(/Input schema:/.test(results[2]!.text), "tool schema missing");
		assert.ok(finalText(run) === "SCRIPT_OK profile verified", "profile scenario failed; response withheld");
		assert.ok(run.appServers.length > 0, "expected pi to start a Codex app-server");
		await assertNoLeftoverAppServers(run);
	});

	it("blocks a writing tool when no UI can approve it", async () => {
		const run = await runPi("write");
		assert.equal(run.code, 0, "Pi exited unsuccessfully; diagnostics withheld");
		assert.ok(!run.invalidOutput, "Pi returned invalid JSON; output withheld");
		assert.ok(finalText(run) === "SCRIPT_BLOCKED", "write must be blocked");
		assert.ok(toolResults(run).some((result) => result.isError && /no UI is available to approve it/.test(result.text)), "missing headless denial");
		await assertNoLeftoverAppServers(run);
	});

	it("blocks a writing tool when PI_CODEX_CONNECTORS_WRITES=deny", async () => {
		const run = await runPi("write", { PI_CODEX_CONNECTORS_WRITES: "deny" });
		assert.equal(run.code, 0, "Pi exited unsuccessfully; diagnostics withheld");
		assert.ok(!run.invalidOutput, "Pi returned invalid JSON; output withheld");
		assert.ok(finalText(run) === "SCRIPT_BLOCKED", "write must be blocked");
		assert.ok(toolResults(run).some((result) => result.isError && /blocked by PI_CODEX_CONNECTORS_WRITES=deny/.test(result.text)), "missing write-policy denial");
	});

	it("requires data consent before discovery in headless mode", async () => {
		const run = await runPi("read", { PI_CODEX_CONNECTORS_DATA: "ask" });
		const results = toolResults(run);
		assert.equal(results[0]?.isError, true);
		assert.ok(/Connector data needs consent/.test(results[0]!.text), "missing data-consent denial");
		assert.equal(run.appServers.length, 0);
	});

	it("denies discovery when data sharing is disabled", async () => {
		const run = await runPi("read", { PI_CODEX_CONNECTORS_DATA: "deny" });
		assert.ok(/data access denied/.test(toolResults(run)[0]!.text), "missing data-policy denial");
		assert.equal(run.appServers.length, 0);
	});

	it("an empty connector allowlist exposes no apps", async () => {
		const run = await runPi("read", { PI_CODEX_CONNECTORS_ALLOW: "" });
		assert.ok(/No Codex connectors/.test(toolResults(run)[0]!.text), "empty allowlist exposed connectors");
		await assertNoLeftoverAppServers(run);
	});

	it("withholds invalid local Codex configuration from the real Pi transcript", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-private-config-"));
		const marker = "SYNTHETIC_PRIVATE_CONFIG_VALUE";
		try {
			writeFileSync(join(home, "config.toml"), `approval_policy = "${marker}"\n`, { mode: 0o600 });
			const run = await runPi("read", { CODEX_HOME: home });
			assert.equal(run.code, 0, "Pi diagnostic scenario failed");
			assert.ok(!run.invalidOutput, "Pi diagnostic scenario returned invalid JSON");
			const results = toolResults(run);
			assert.ok(results[0]?.isError, "invalid config must fail discovery");
			assert.ok(/private diagnostics were withheld/.test(results[0]!.text), "missing safe diagnostic");
			const transcript = JSON.stringify(run.events);
			assert.ok(!transcript.includes(marker), "private config value leaked into transcript");
			assert.ok(!transcript.includes(home), "private config path leaked into transcript");
			assert.ok(finalText(run) === "SCRIPT_FAIL GitHub connector unavailable", "scenario must use a fixed failure label");
			await assertNoLeftoverAppServers(run);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("rejects a tool that is not in the connected catalog", async () => {
		const run = await runPi("unknown");
		assert.equal(run.code, 0, "Pi exited unsuccessfully; diagnostics withheld");
		assert.ok(!run.invalidOutput, "Pi returned invalid JSON; output withheld");
		assert.ok(finalText(run) === "SCRIPT_REJECTED", "unknown tool must be rejected");
		assert.ok(/Unknown Codex connector tool/.test(toolResults(run)[0]!.text), "missing unknown-tool rejection");
	});
});
