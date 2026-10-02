import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerClient, OutcomeUnknownError } from "./app-server.ts";

/**
 * Codex connectors ("apps") through a model-free Codex app-server thread.
 *
 * Flow:
 * 1. `thread/start` opens an ephemeral thread with only the apps feature enabled. The user's own
 *    Codex MCP servers are disabled so they neither start nor leak into the catalog.
 * 2. `app/installed` returns the account's installed connectors; enabled + callable ones are exposed.
 *    (`app/list` is the whole public catalog, thousands of apps, and too slow to page through.)
 * 3. `mcpServerStatus/list` returns the `codex_apps` MCP server tools; `_meta.connector_id` maps each
 *    tool to its connector.
 * 4. `mcpServer/tool/call` runs a tool. No Codex model turn is ever started.
 *
 * Credentials stay owned by Codex (`codex login`); this module never reads them.
 */

const APPS_SERVER = "codex_apps";
const MAX_PAGES = 200;

export interface Connector {
	id: string;
	name: string;
	description: string;
	tools: ConnectorTool[];
}

export interface ConnectorTool {
	name: string;
	title: string | undefined;
	description: string;
	connectorId: string;
	connectorName: string;
	inputSchema: Record<string, unknown>;
	readOnly: boolean;
	destructive: boolean;
}

export interface McpContent {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	[key: string]: unknown;
}

export interface ToolCallResult {
	content: McpContent[];
	structuredContent?: unknown;
	isError: boolean;
}

export type ElicitationResponse = { action: "accept" | "decline" | "cancel"; content: unknown; _meta: null };
export type ElicitationHandler = (request: ElicitationRequest) => Promise<ElicitationResponse>;

export interface ElicitationRequest {
	serverName: string;
	mode: string;
	message: string;
	url?: string;
	requestedSchema?: unknown;
}

export interface CodexConnectorsOptions {
	/** Codex executable. Defaults to `codex` on PATH. */
	command?: string;
	env?: NodeJS.ProcessEnv;
	/** Answers connector elicitations (confirmations). Defaults to declining. */
	onElicitation?: ElicitationHandler;
	discoveryTimeoutMs?: number;
	callTimeoutMs?: number;
}

interface Session {
	workspace?: string;
	client: AppServerClient;
	threadId: string;
	connectors: Connector[];
	tools: Map<string, ConnectorTool>;
}

type InstalledApp = { id: string; runtimeName: string | null; enabled: boolean; callable: boolean };
type Page<T> = { data: T[]; nextCursor: string | null };
type RawTool = {
	name?: unknown;
	title?: unknown;
	description?: unknown;
	inputSchema?: unknown;
	annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown } | null;
	_meta?: { connector_id?: unknown; connector_description?: unknown } | null;
};
type McpServerStatus = { name: string; tools: Record<string, RawTool>; toolsError: string | null };

export class CodexConnectors {
	private readonly options: CodexConnectorsOptions;
	private session: Promise<Session> | undefined = undefined;
	private closed = false;
	private writeOutcomeUnknown = false;

	constructor(options: CodexConnectorsOptions = {}) {
		this.options = options;
	}

	/** Process id of the running app-server, if any. */
	async pid(): Promise<number | undefined> {
		return this.session ? (await this.session).client.pid : undefined;
	}

	async connectors(): Promise<Connector[]> {
		return (await this.ready()).connectors;
	}

	async tool(name: string): Promise<ConnectorTool | undefined> {
		return (await this.ready()).tools.get(name);
	}

	async call(name: string, args: Record<string, unknown>, signal?: AbortSignal, expectedTool?: ConnectorTool): Promise<ToolCallResult> {
		const session = await this.ready();
		if (!session.tools.has(name)) {
			throw new Error(`Unknown Codex connector tool "${name}". Use codex_connectors to find available tools.`);
		}
		const tool = session.tools.get(name)!;
		if (expectedTool && tool !== expectedTool) {
			throw new Error("Connector catalog changed before dispatch. Rediscover the tool and obtain fresh approval; nothing was sent.");
		}
		if (this.writeOutcomeUnknown && (!tool.readOnly || tool.destructive)) {
			throw new Error("Writes blocked after an unknown connector outcome. Verify the previous action in the connected app, then restart the Pi session before writing again.");
		}
		const result = await session.client.request<{
			content?: McpContent[];
			structuredContent?: unknown;
			isError?: boolean;
		}>(
			"mcpServer/tool/call",
			{ threadId: session.threadId, server: APPS_SERVER, tool: name, arguments: args },
			{ timeoutMs: this.options.callTimeoutMs ?? 120_000, signal },
		).catch((error) => {
			if (error instanceof OutcomeUnknownError && (!tool.readOnly || tool.destructive)) this.writeOutcomeUnknown = true;
			throw error;
		});
		return {
			content: Array.isArray(result.content) ? result.content : [],
			structuredContent: result.structuredContent ?? undefined,
			isError: result.isError === true,
		};
	}

	/** Drop the catalog and app-server; the next use rediscovers connectors. */
	async refresh(): Promise<Connector[]> {
		await this.stop();
		return this.connectors();
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.stop();
	}

	private async stop(): Promise<void> {
		const session = this.session;
		this.session = undefined;
		if (!session) return;
		try {
			const ready = await session;
			try { await ready.client.close(); } finally {
				if (ready.workspace) rmSync(ready.workspace, { recursive: true, force: true });
			}
		} catch {
			// Start failures are already reported to the caller that awaited them.
		}
	}

	private async ready(): Promise<Session> {
		if (this.closed) throw new Error("Codex connectors are closed");
		this.session ??= this.start();
		const current = this.session;
		let session: Session;
		try {
			session = await current;
		} catch (error) {
			// A failed start must not poison later calls.
			if (this.session === current) this.session = undefined;
			throw error;
		}
		if (session.client.isAlive) return session;
		// The app-server died (crash, sleep, update): start a fresh one.
		if (session.workspace) rmSync(session.workspace, { recursive: true, force: true });
		if (this.session === current) this.session = undefined;
		return this.ready();
	}

	private async start(): Promise<Session> {
		const workspace = mkdtempSync(join(tmpdir(), "pi-codex-connectors-"));
		const client = await AppServerClient.start({
			command: this.options.command ?? process.env.PI_CODEX_CONNECTORS_CODEX ?? "codex",
			env: this.options.env,
			cwd: workspace,
			onServerRequest: (method, params) => this.answerServerRequest(method, params),
		}).catch((error) => { rmSync(workspace, { recursive: true, force: true }); throw error; });
		try {
			const timeoutMs = this.options.discoveryTimeoutMs ?? 90_000;
			const config = await client.request<{ config: { mcp_servers?: Record<string, unknown> | null } }>(
				"config/read",
				{ cwd: workspace },
				{ timeoutMs },
			);
			const threadConfig: Record<string, unknown> = {
				"features.apps": true,
				"features.plugins": false,
				"features.hooks": false,
				"features.memories": false,
				"features.multi_agent": false,
				"features.shell_tool": false,
				"features.unified_exec": false,
				web_search: "disabled",
			};
			for (const name of Object.keys(config.config.mcp_servers ?? {})) {
				threadConfig[`mcp_servers.${name}.enabled`] = false;
			}
			const thread = await client.request<{ thread: { id: string } }>(
				"thread/start",
				{ cwd: workspace, ephemeral: true, approvalPolicy: "never", sandbox: "read-only", config: threadConfig },
				{ timeoutMs },
			);
			const threadId = thread.thread.id;
			const installed = await client.request<{ apps: InstalledApp[] }>(
				"app/installed",
				{ threadId },
				{ timeoutMs },
			);
			const allowed = process.env.PI_CODEX_CONNECTORS_ALLOW?.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
			const apps = installed.apps.filter((app) => app.enabled && app.callable &&
				(allowed === undefined || allowed.includes(app.id.toLowerCase()) || allowed.includes((app.runtimeName ?? "").toLowerCase())));
			const rawTools = await this.listAppTools(client, threadId, timeoutMs);
			return { ...buildSession(client, threadId, apps, rawTools), workspace };
		} catch (error) {
			await client.close();
			rmSync(workspace, { recursive: true, force: true });
			throw error;
		}
	}

	private async listAppTools(client: AppServerClient, threadId: string, timeoutMs: number): Promise<RawTool[]> {
		const tools: RawTool[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < MAX_PAGES; page++) {
			const result: Page<McpServerStatus> = await client.request(
				"mcpServerStatus/list",
				{ threadId, limit: 100, detail: "toolsAndAuthOnly", cursor },
				{ timeoutMs },
			);
			for (const server of result.data) {
				if (server.name !== APPS_SERVER) continue;
				if (server.toolsError) throw new Error("Codex could not load connector tools. Check Codex locally; private diagnostics were withheld.");
				tools.push(...Object.values(server.tools));
			}
			cursor = result.nextCursor;
			if (!cursor) return tools;
		}
		throw new Error("Codex tool catalog exceeded the pagination limit");
	}

	private async answerServerRequest(method: string, params: unknown): Promise<unknown> {
		if (method !== "mcpServer/elicitation/request") throw new Error(`Unsupported server request ${method}`);
		const request = params as { serverName?: string; mode?: string; message?: string; url?: string; requestedSchema?: unknown };
		const handler = this.options.onElicitation;
		if (!handler) return { action: "decline", content: null, _meta: null };
		return handler({
			serverName: request.serverName ?? APPS_SERVER,
			mode: request.mode ?? "form",
			message: request.message ?? "",
			url: request.url,
			requestedSchema: request.requestedSchema,
		});
	}
}

function buildSession(client: AppServerClient, threadId: string, apps: InstalledApp[], rawTools: RawTool[]): Session {
	const connectors = new Map<string, Connector>(
		apps.map((app) => [app.id, { id: app.id, name: app.runtimeName ?? app.id, description: "", tools: [] }]),
	);
	const tools = new Map<string, ConnectorTool>();
	for (const raw of rawTools) {
		const connector = typeof raw._meta?.connector_id === "string" ? connectors.get(raw._meta.connector_id) : undefined;
		if (!connector || typeof raw.name !== "string" || !raw.name || !isObject(raw.inputSchema)) continue;
		if (!connector.description && typeof raw._meta?.connector_description === "string") {
			connector.description = raw._meta.connector_description;
		}
		const tool: ConnectorTool = {
			name: raw.name,
			title: typeof raw.title === "string" ? raw.title : undefined,
			description: typeof raw.description === "string" ? raw.description : "",
			connectorId: connector.id,
			connectorName: connector.name,
			inputSchema: raw.inputSchema,
			readOnly: raw.annotations?.readOnlyHint === true,
			destructive: raw.annotations?.destructiveHint === true,
		};
		connector.tools.push(tool);
		tools.set(tool.name, tool);
	}
	const list = [...connectors.values()].filter((connector) => connector.tools.length > 0).sort((a, b) => a.name.localeCompare(b.name));
	for (const connector of list) connector.tools.sort((a, b) => a.name.localeCompare(b.name));
	return { client, threadId, connectors: list, tools };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
