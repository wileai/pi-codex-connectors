import { homedir } from "node:os";
import { AppApprovals } from "./computer-permissions.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { ComputerBridge, type Elicitation, type ElicitationReply } from "./computer-bridge.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Optional macOS integration using the user-installed desktop runtime. */
export default function computerUse(pi: ExtensionAPI) {
	if (process.env.PI_CODEX_COMPUTER_USE !== "1") return;
	if (process.platform !== "darwin") throw new Error("Computer Use requires macOS.");
	const app = process.env.PI_CODEX_COMPUTER_APP ?? "/Applications/ChatGPT.app";
	const root = join(app, "Contents/Resources/cua_node");
	const modules = join(root, "lib/node_modules");
	const node = join(root, "bin/node");
	const repl = join(root, "bin/node_repl");
	const wrapper = join(modules, "@oai/cua-repl/bin/cua-repl.mjs");
	const approvals = new AppApprovals(join((process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent")).replace(/^~(?=\/|$)/, homedir()), "computer-use-approvals.json"));
	for (const path of [node, repl, wrapper, join(modules, "@oai/sky/package.json")]) {
		if (!existsSync(path)) throw new Error("Desktop Computer Use runtime missing. Set PI_CODEX_COMPUTER_APP to the installed ChatGPT.app path.");
	}
	let bridge: ComputerBridge | undefined;
	let activeContext: ExtensionContext | undefined;
	let busy = false;
	let generation = 0;
	let dialogAbort = new AbortController();
	const runtimeEnv = {
		...process.env,
		SKY_CUA_SERVICE_PATH: process.env.SKY_CUA_SERVICE_PATH ?? join(homedir(), ".codex/computer-use/Codex Computer Use.app"),
		CUA_REPL_NODE_REPL_PATH: repl,
		CUA_REPL_ENABLED_SURFACES: "computer",
		NODE_REPL_UNTRUSTED_ENV_ALLOWLIST: "CUA_REPL_ENABLED_SURFACES",
		NODE_REPL_JS_BANNER: 'globalThis.sky = (await import("@oai/sky")).sky;',
		NODE_REPL_NODE_PATH: node,
		NODE_REPL_NODE_MODULE_DIRS: modules,
		NODE_REPL_TRUSTED_CODE_PATHS: modules,
		NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ sky: "@oai/sky/service" }),
	};
	const elicit = async (request: Elicitation): Promise<ElicitationReply> => {
		const ctx = activeContext;
		const current = generation;
		const result = await approvals.confirm(ctx, request, dialogAbort.signal);
		return current === generation ? result : { action: "cancel" };
	};
	const reset = async () => {
		generation++;
		dialogAbort.abort();
		dialogAbort = new AbortController();
		const previous = bridge;
		bridge = undefined; activeContext = undefined;
		await previous?.close();
	};
	pi.on("session_start", async () => { approvals.clearSession(); await reset(); });
	pi.on("session_shutdown", reset);
	const run = async (name: string, args: Record<string, unknown>, signal: AbortSignal | undefined, ctx: ExtensionContext) => {
		if (busy) throw new Error("Run Computer Use calls one at a time; wait for the current call and its approval.");
		if (signal?.aborted) throw new Error("Computer Use call was cancelled before dispatch.");
		busy = true; activeContext = ctx;
		const current = generation;
		const stop = () => { void reset(); };
		signal?.addEventListener("abort", stop, { once: true });
		try {
			if (!bridge) {
				const started = await ComputerBridge.start(node, [wrapper], runtimeEnv, elicit);
				if (current !== generation || signal?.aborted) { await started.close(); throw new Error("Computer Use session changed during startup."); }
				bridge = started;
			}
			const result = await bridge.request("tools/call", { name, arguments: args }, Math.max(60_000, Number(args.timeout_ms ?? 30_000) + 10_000));
			if (current !== generation) throw new Error("Computer Use session changed; stale output discarded.");
			if (result.isError) {
				const message = result.content?.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n") ?? "Computer Use failed.";
				throw new Error(message);
			}
			const content = (result.content ?? []).filter((block: any) => block.type === "text" || block.type === "image");
			return { content: content.length ? content : [{ type: "text", text: "(completed)" }], details: {} };
		} finally {
			signal?.removeEventListener("abort", stop);
			activeContext = undefined; busy = false;
		}
	};
	pi.registerTool({
		name: "mcp__codex_computer__js", label: "Computer Use",
		description: "Run persistent JavaScript through the desktop Computer Use runtime. Native app approvals are shown as Pi confirmation dialogs. Initialize sky with await import('@oai/sky'). Use only for the user's requested UI task; follow runtime instructions. After a denied approval, stop instead of trying another route.",
		parameters: Type.Object({ code: Type.String(), title: Type.Optional(Type.String()), timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 300000 })) }),
		execute: async (_id, params, signal, _onUpdate, ctx) => run("js", params, signal, ctx),
	});
	pi.registerTool({
		name: "mcp__codex_computer__js_reset", label: "Reset Computer Use JavaScript",
		description: "Reset JavaScript state. This does not approve app access or resolve denied permissions.",
		parameters: Type.Object({}),
		execute: async (_id, params, signal, _onUpdate, ctx) => run("js_reset", {}, signal, ctx),
	});
	pi.on("before_agent_start", async (event) => ({
		systemPrompt: event.systemPrompt + `\n\nComputer Use:\nUse mcp__codex_computer__js for UI work. Initialize with: var sky = (await import("@oai/sky")).sky;\nUse only @oai/sky, never cua or @oai/cua. Print state.text with nodeRepl.write. To show a screenshot, use nodeRepl.emitImage({bytes:await (await import("node:fs/promises")).readFile(new URL(state.screenshot.url)),mimeType:"image/jpeg"}). AppState has .text and .screenshot.url. Use sky.list_apps(), sky.get_app_state({app,disableDiff:true}), sky.click({app,element_index}), sky.press_key({app,key}), and sky.type_text({app,text}). Read fresh app state after each action before reusing element indices. Follow the Computer Use instructions and confirmations returned by the runtime. If access is declined or approval is unavailable, stop and report it. Do not retry repeatedly, switch apps, or reset to evade approval. Do not bypass native approvals or use alternative UI automation. Never send messages, submit forms, delete data, or change settings without the applicable user confirmation. Screenshots and app content enter this Pi session and its selected model.\n`,
	}));
	pi.registerCommand("codex-computer", {
		description: "Show Computer Use status; forget clears saved and session app approvals",
		handler: async (_args, ctx) => {
			if (_args.trim() === "forget") { await reset(); approvals.forget(); ctx.ui.notify("Computer Use approvals cleared.", "info"); return; }
			const pkg = JSON.parse(readFileSync(join(modules, "@oai/sky/package.json"), "utf8"));
			ctx.ui.notify(`Computer Use: @oai/sky ${pkg.version}. Approval bridge enabled; app access prompts appear in Pi. Try: List available apps using Codex Computer Use, without opening or changing anything.`, "info");
		},
	});
}
