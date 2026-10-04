import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateOutput } from "./output.ts";
import { registerWebSearch } from "./web-search-extension.ts";
import { Type } from "typebox";
import {
	CodexConnectors,
	type Connector,
	type ConnectorTool,
	type ElicitationRequest,
	type ElicitationResponse,
	type ToolCallResult,
} from "./connectors.ts";

/**
 * Exposes every connected Codex connector (GitHub, Gmail, Slack, ...) to any pi model.
 *
 * Hundreds of connector tools would flood the context, so the model gets three small tools:
 * list connectors/tools, read one tool's schema, and call a tool. The catalog stays in Codex.
 *
 * Tools not annotated read-only need approval. Set PI_CODEX_CONNECTORS_WRITES to
 * "ask" (default: confirm in the UI, deny without UI), "allow", or "deny".
 */

const MAX_LISTED_TOOLS = 80;
const DESCRIPTION_PREVIEW = 160;

type WritePolicy = "ask" | "allow" | "deny";

export default function codexConnectorsExtension(pi: ExtensionAPI) {
	registerWebSearch(pi);
	let connectors: CodexConnectors | undefined;
	// Elicitations arrive on the app-server channel, not on a tool call; answer with the latest UI.
	let activeContext: ExtensionContext | undefined;
	let dataApproved = false;
	let dataApproval: Promise<void> | undefined;
	let sessionGeneration = 0;
	const approveData = async (ctx: ExtensionContext) => {
		const policy = process.env.PI_CODEX_CONNECTORS_DATA;
		if (policy === "deny") throw new Error("Connector data access denied by PI_CODEX_CONNECTORS_DATA=deny.");
		if (dataApproved) return;
		if (!dataApproval) {
			const generation = sessionGeneration;
			dataApproval = (async () => {
				if (policy !== "allow") {
					if (!ctx.hasUI) throw new Error("Connector data needs consent. Set PI_CODEX_CONNECTORS_DATA=allow to share connector results with the selected model.");
					if (!await ctx.ui.confirm("Share connector data with this Pi session?", "Connected app names, schemas and results will enter the selected model's context and may be retained by Pi or its model provider. Read calls can retrieve private data. Continue only with a trusted model.")) {
						throw new Error("Connector data access declined.");
					}
				}
				if (generation !== sessionGeneration) throw new Error("Session changed during connector consent. Try again in the current session.");
				dataApproved = true;
			})();
		}
		const pending = dataApproval;
		try { await pending; } finally {
			if (dataApproval === pending) dataApproval = undefined;
		}
	};

	const resetSession = async () => {
		sessionGeneration++;
		const current = connectors;
		connectors = undefined;
		activeContext = undefined;
		dataApproved = false;
		dataApproval = undefined;
		await current?.close();
	};
	pi.on("session_start", resetSession);
	pi.on("session_shutdown", resetSession);

	const getConnectors = (ctx: ExtensionContext): CodexConnectors => {
		activeContext = ctx;
		connectors ??= new CodexConnectors({ onElicitation: (request) => elicit(activeContext, request) });
		return connectors;
	};

	pi.registerTool({
		name: "codex_connectors",
		label: "Codex connectors",
		description:
			"List the user's connected Codex (ChatGPT) apps such as GitHub, Gmail, Google Calendar, Google Drive, Slack, Linear and Figma. " +
			"Without arguments it lists connectors. With `connector` and/or `query` it lists matching tools. " +
			"Then use codex_connector_schema to read a tool's input schema and codex_connector_call to run it.",
		promptSnippet: "codex_connectors: find tools of the user's connected apps (GitHub, Gmail, Calendar, Drive, Slack, Linear, ...)",
		promptGuidelines: [
			"For requests about the user's GitHub, Gmail, Google Calendar/Drive, Slack, Linear, Figma or other connected apps: codex_connectors to find the tool, codex_connector_schema for its arguments, then codex_connector_call.",
		],
		parameters: Type.Object({
			connector: Type.Optional(
				Type.String({ description: "Connector name, id, or tool prefix, e.g. 'GitHub' or 'google_calendar'" }),
			),
			query: Type.Optional(Type.String({ description: "Words that must appear in the tool name or description" })),
			refresh: Type.Optional(Type.Boolean({ description: "Reload connectors and tools from Codex" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await approveData(ctx);
			const service = getConnectors(ctx);
			const all = params.refresh ? await service.refresh() : await service.connectors();
			if (!params.connector && !params.query) return text(formatConnectors(all));
			const selected = params.connector ? all.filter((connector) => matchesConnector(connector, params.connector ?? "")) : all;
			if (selected.length === 0) {
				throw new Error(`No connector matches "${params.connector}". Connected: ${all.map((c) => c.name).join(", ")}`);
			}
			const words = (params.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
			const tools = selected
				.flatMap((connector) => connector.tools)
				.filter((tool) => {
					const haystack = `${tool.name} ${tool.title ?? ""} ${tool.description}`.toLowerCase();
					return words.every((word) => haystack.includes(word));
				});
			return text(formatTools(tools));
		},
	});

	pi.registerTool({
		name: "codex_connector_schema",
		label: "Codex connector schema",
		description: "Show the full description and JSON input schema of one Codex connector tool before calling it.",
		parameters: Type.Object({
			tool: Type.String({ description: "Exact tool name from codex_connectors, e.g. 'github.get_repo'" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await approveData(ctx);
			const tool = await requireTool(getConnectors(ctx), params.tool);
			return text(
				[
					`${tool.name} (${tool.connectorName}, ${accessLabel(tool)})`,
					"",
					tool.description,
					"",
					"Input schema:",
					JSON.stringify(tool.inputSchema, null, 2),
				].join("\n"),
			);
		},
	});

	pi.registerTool({
		name: "codex_connector_call",
		label: "Codex connector call",
		description:
			"Run one Codex connector tool with arguments matching its input schema (see codex_connector_schema). " +
			"Tools that are not read-only may require user approval.",
		parameters: Type.Object({
			tool: Type.String({ description: "Exact tool name, e.g. 'github.get_repo'" }),
			arguments: Type.Optional(
				Type.Record(Type.String(), Type.Unknown(), { description: "Tool arguments as a JSON object" }),
			),
		}),
		// Weaker models often send `arguments` as a JSON string.
		prepareArguments(raw) {
			const args = (typeof raw === "object" && raw !== null ? { ...raw } : {}) as {
				tool: string;
				arguments?: Record<string, unknown>;
			};
			const nested: unknown = args.arguments;
			if (typeof nested === "string") {
				try {
					args.arguments = nested.trim() ? (JSON.parse(nested) as Record<string, unknown>) : {};
				} catch {
					// Leave invalid JSON for schema validation to report.
				}
			}
			return args;
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			await approveData(ctx);
			const service = getConnectors(ctx);
			const tool = await requireTool(service, params.tool);
			const args = params.arguments ?? {};
			if (!tool.readOnly || tool.destructive) await approveWrite(tool, args, ctx);
			const result = await service.call(tool.name, args, signal, tool);
			return formatCallResult(tool, result);
		},
	});

	pi.registerCommand("codex-connectors", {
		description: "List connected Codex connectors (use 'refresh' to reload)",
		handler: async (args, ctx) => {
			await approveData(ctx);
			const service = getConnectors(ctx);
			try {
				const all = args.trim() === "refresh" ? await service.refresh() : await service.connectors();
				ctx.ui.notify(formatConnectors(all), "info");
			} catch (error) {
				ctx.ui.notify(`Codex connectors unavailable: ${errorMessage(error)}`, "error");
			}
		},
	});
}

async function requireTool(service: CodexConnectors, name: string): Promise<ConnectorTool> {
	const tool = await service.tool(name);
	if (!tool) throw new Error(`Unknown Codex connector tool "${name}". Use codex_connectors with a query to find it.`);
	return tool;
}

async function approveWrite(tool: ConnectorTool, args: Record<string, unknown>, ctx: ExtensionContext): Promise<void> {
	const policy = writePolicy();
	if (policy === "allow") return;
	const denied = `${tool.name} can change data in ${tool.connectorName}`;
	if (policy === "deny") throw new Error(`${denied}; blocked by PI_CODEX_CONNECTORS_WRITES=deny.`);
	if (!ctx.hasUI) {
		throw new Error(`${denied}; no UI is available to approve it. Set PI_CODEX_CONNECTORS_WRITES=allow to permit it.`);
	}
	const serialized = JSON.stringify(args, null, 2);
	if (serialized.length > 2000) {
		throw new Error("Write arguments exceed the safe approval display limit (2000 characters). Reduce the operation size; nothing was sent.");
	}
	const approved = await ctx.ui.confirm(
		`Allow ${tool.connectorName}: ${tool.name}?`,
		`${accessLabel(tool)}\n\n${serialized}`,
	);
	if (!approved) throw new Error(`The user declined ${tool.name}.`);
}

function writePolicy(): WritePolicy {
	const value = process.env.PI_CODEX_CONNECTORS_WRITES;
	return value === "allow" || value === "deny" ? value : "ask";
}

async function elicit(ctx: ExtensionContext | undefined, request: ElicitationRequest): Promise<ElicitationResponse> {
	const decline: ElicitationResponse = { action: "decline", content: null, _meta: null };
	if (!ctx?.hasUI) return decline;
	if (request.mode === "url") {
		ctx.ui.notify(`${request.message}\n${request.url ?? ""}`, "warning");
		return decline;
	}
	// Only confirmation forms (no fields to fill) can be answered with a yes/no dialog.
	const schema = request.requestedSchema as { properties?: Record<string, unknown> } | undefined;
	if (schema?.properties && Object.keys(schema.properties).length > 0) {
		ctx.ui.notify(`Codex connector asked for input pi cannot collect: ${request.message}`, "warning");
		return decline;
	}
	const accepted = await ctx.ui.confirm("Codex connector", request.message);
	return accepted ? { action: "accept", content: {}, _meta: null } : decline;
}

function matchesConnector(connector: Connector, value: string): boolean {
	const wanted = normalize(value);
	if (normalize(connector.id) === wanted || normalize(connector.name) === wanted) return true;
	return connector.tools.some((tool) => normalize(tool.name.split(".")[0] ?? "") === wanted);
}

function normalize(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function formatConnectors(connectors: Connector[]): string {
	if (connectors.length === 0) {
		return "No Codex connectors are connected. Connect apps in ChatGPT or Codex, then call codex_connectors with refresh: true.";
	}
	const lines = connectors.map((connector) => {
		const readOnly = connector.tools.filter((tool) => tool.readOnly).length;
		const prefixes = [...new Set(connector.tools.map((tool) => tool.name.split(".")[0]))].join(", ");
		const description = connector.description ? ` - ${truncate(connector.description, DESCRIPTION_PREVIEW)}` : "";
		return `- ${connector.name} [${prefixes || "no tools"}]: ${connector.tools.length} tools (${readOnly} read-only)${description}`;
	});
	return `Connected Codex connectors (${connectors.length}):\n${lines.join("\n")}`;
}

function formatTools(tools: ConnectorTool[]): string {
	if (tools.length === 0) return "No matching tools. Try fewer query words or another connector.";
	const lines = tools
		.slice(0, MAX_LISTED_TOOLS)
		.map((tool) => `- ${tool.name} [${accessLabel(tool)}]: ${truncate(firstSentence(tool.description), DESCRIPTION_PREVIEW)}`);
	const more = tools.length > MAX_LISTED_TOOLS ? `\n... ${tools.length - MAX_LISTED_TOOLS} more; narrow with query.` : "";
	return `${tools.length} matching tools:\n${lines.join("\n")}${more}`;
}

async function formatCallResult(tool: ConnectorTool, result: ToolCallResult) {
	if (result.isError) throw new Error("Codex connector reported a tool error; private response details were withheld. Check the connected app before retrying.");
	const parts: string[] = [];
	const images: ImageContent[] = [];
	for (const item of result.content) {
		if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
		else if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
			images.push({ type: "image", data: item.data, mimeType: item.mimeType });
		} else parts.push(JSON.stringify(item));
	}
	if (result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent, null, 2));
	const output = parts.join("\n\n") || "(no output)";

	const truncation = truncateOutput(output);
	let body = truncation.content;
	if (truncation.truncated) {
		body += `\n\n[Output truncated to ${truncation.outputLines} lines / ${truncation.outputBytes} bytes. No full response was saved to disk. Narrow the query or use pagination.]`;
	}
	const content: (TextContent | ImageContent)[] = [{ type: "text", text: body }, ...images];
	return { content, details: { tool: tool.name, connector: tool.connectorName } };
}

function accessLabel(tool: ConnectorTool): string {
	if (tool.readOnly && !tool.destructive) return "read-only";
	return tool.destructive ? "writes, destructive" : "writes";
}

function firstSentence(value: string): string {
	const match = /^(.+?[.!?])(\s|$)/s.exec(value);
	return (match?.[1] ?? value).replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }], details: undefined };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
