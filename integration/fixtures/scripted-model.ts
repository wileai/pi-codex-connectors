/**
 * Test-only pi extension: a scripted model provider ("scripted/connectors").
 * It stands in for an LLM so scenarios drive the real pi CLI and the real extension
 * without spending tokens. PI_CODEX_SCRIPT selects the script.
 */
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type ToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Step = (context: TranscriptContext) => AssistantMessage;

function lastToolResult(context: TranscriptContext): { text: string; isError: boolean } {
	const message = context.messages.at(-1);
	if (message?.role !== "toolResult") throw new Error("script expected a tool result");
	const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
	return { text, isError: message.isError };
}

const callTool = (name: string, args: ToolCall["arguments"]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

const say = (text: string) => fauxAssistantMessage(fauxText(text));

const scripts: Record<string, Step[]> = {
	// Discover connectors -> find GitHub profile tool -> read schema -> call it -> report.
	read: [
		() => callTool("codex_connectors", {}),
		(context) => {
			const { text } = lastToolResult(context);
			if (!/GitHub/.test(text)) return say(`SCRIPT_FAIL no GitHub connector in: ${text}`);
			return callTool("codex_connectors", { connector: "GitHub", query: "profile" });
		},
		(context) => {
			const { text } = lastToolResult(context);
			if (!text.includes("github.get_profile")) return say(`SCRIPT_FAIL profile tool not listed: ${text}`);
			return callTool("codex_connector_schema", { tool: "github.get_profile" });
		},
		// Arguments as a JSON string, the way weaker models often send them.
		() => callTool("codex_connector_call", { tool: "github.get_profile", arguments: "{}" }),
		(context) => {
			const { text, isError } = lastToolResult(context);
			const nickname = /"nickname":\s*"([^"]+)"/.exec(text)?.[1];
			return say(isError || !nickname ? `SCRIPT_FAIL ${text}` : `SCRIPT_OK github user ${nickname}`);
		},
	],
	// A tool that writes must not run without approval when there is no UI.
	write: [
		() => callTool("codex_connectors", { connector: "GitHub" }),
		(context) => {
			const { text } = lastToolResult(context);
			const tool = /^- (\S+) \[writes/m.exec(text)?.[1];
			if (!tool) return say(`SCRIPT_FAIL no writing tool listed: ${text}`);
			// Empty arguments: even if the guard failed, the connector would reject the call.
			return callTool("codex_connector_call", { tool, arguments: process.env.PI_CODEX_SCRIPT === "write-long" ? { body: "x".repeat(2100), recipient: "nobody@example.invalid" } : {} });
		},
		(context) => {
			const { text, isError } = lastToolResult(context);
			return say(isError ? `SCRIPT_BLOCKED ${text}` : `SCRIPT_FAIL write ran: ${text}`);
		},
	],
	unknown: [
		() => callTool("codex_connector_call", { tool: "github.no_such_tool", arguments: {} }),
		(context) => {
			const { text, isError } = lastToolResult(context);
			return say(isError ? `SCRIPT_REJECTED ${text}` : `SCRIPT_FAIL ${text}`);
		},
	],
};

export default function scriptedModel(pi: ExtensionAPI) {
	const script = scripts[process.env.PI_CODEX_SCRIPT === "write-long" ? "write" : process.env.PI_CODEX_SCRIPT ?? "read"];
	if (!script) throw new Error(`Unknown PI_CODEX_SCRIPT ${process.env.PI_CODEX_SCRIPT}`);
	const faux = fauxProvider({ provider: "scripted", models: [{ id: "connectors", name: "Scripted connectors" }] });
	faux.setResponses(script);
	pi.registerProvider(faux.provider);
}
