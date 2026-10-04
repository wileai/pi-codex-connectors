import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { AppServerClient } from "./app-server.ts";

// Codex's standalone retrieval endpoint; deliberately not a configurable credential destination.
const SEARCH_ENDPOINT = "https://chatgpt.com/backend-api/codex/alpha/search";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const SEARCH_MODES = ["disabled", "cached", "indexed", "live"] as const;
export type SearchMode = typeof SEARCH_MODES[number];

export interface WebSearchInput {
	search_query?: Array<{ q: string; recency?: number; domains?: string[] }>;
	open?: Array<{ ref_id: string; lineno?: number }>;
	find?: Array<{ ref_id: string; pattern: string }>;
	click?: Array<{ ref_id: string; id: number }>;
	response_length?: "short" | "medium" | "long";
	mode?: Exclude<SearchMode, "disabled">;
	allowed_domains?: string[];
}

export interface WebSearchOptions {
	/** Maximum access selected by the user, never by a model tool argument. */
	mode: SearchMode;
	command?: string;
	env?: NodeJS.ProcessEnv;
	/** Required endpoint routing field; does not start a model turn. */
	model?: string;
	timeoutMs?: number;
}

class SearchError extends Error {}

export function searchMode(value: string | undefined): SearchMode {
	if (value === undefined) return "cached";
	if ((SEARCH_MODES as readonly string[]).includes(value)) return value as SearchMode;
	throw new SearchError("Invalid web search mode. Choose disabled, cached, indexed, or live.");
}

/** Direct retrieval only: app-server supplies auth, no thread/start or turn/start calls. */
export class CodexWebSearch {
	private readonly id = randomUUID();
	private readonly abort = new AbortController();
	private readonly pending = new Set<Promise<unknown>>();
	private readonly options: WebSearchOptions;

	constructor(options: WebSearchOptions) {
		this.options = { ...options, mode: searchMode(options.mode) };
	}

	async close(): Promise<void> {
		this.abort.abort();
		await Promise.allSettled([...this.pending]);
	}

	search(input: WebSearchInput, signal?: AbortSignal): Promise<{ output: string; mode: SearchMode }> {
		const request = this.run(input, signal);
		this.pending.add(request);
		void request.finally(() => this.pending.delete(request)).catch(() => {});
		return request;
	}

	private async run(input: WebSearchInput, callerSignal?: AbortSignal) {
		const mode = input.mode ?? this.options.mode;
		if (mode === "disabled" || this.options.mode === "disabled") throw new SearchError("Codex web search is disabled. Use /codex-web-search to select a mode.");
		if (!(SEARCH_MODES as readonly string[]).includes(mode) || SEARCH_MODES.indexOf(mode) > SEARCH_MODES.indexOf(this.options.mode)) {
			throw new SearchError(`Web search exceeds the user-selected ${this.options.mode} mode. Ask the user to change /codex-web-search; do not retry with broader access.`);
		}
		if (!input.search_query?.length && !input.open?.length && !input.find?.length && !input.click?.length) {
			throw new SearchError("Provide at least one search_query, open, find, or click operation.");
		}
		const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 60_000);
		const signal = AbortSignal.any([this.abort.signal, timeout, ...(callerSignal ? [callerSignal] : [])]);
		let client: AppServerClient | undefined;
		try {
			signal.throwIfAborted();
			client = await AppServerClient.start({
				command: this.options.command ?? process.env.PI_CODEX_CONNECTORS_CODEX ?? "codex",
				env: this.options.env,
				cwd: tmpdir(),
				signal,
			});
			// Codex owns credential storage and refresh (including keychain-backed logins).
			// Tokens live only in this request and never enter Pi tool content/details.
			const auth = await client.request<{ authMethod: string | null; authToken: string | null }>(
				"getAuthStatus", { includeToken: true, refreshToken: false }, { signal },
			);
			if (auth.authMethod !== "chatgpt" || !auth.authToken) {
				throw new SearchError("Web search requires a ChatGPT Codex login. Run codex login, then try again.");
			}
			const headers: Record<string, string> = {
				authorization: `Bearer ${auth.authToken}`,
				"content-type": "application/json",
			};
			const accountId = accountIdFromToken(auth.authToken);
			if (accountId) headers["chatgpt-account-id"] = accountId;
			// Explicitly select fields: never forward arbitrary model-supplied settings or history.
			const response = await fetch(SEARCH_ENDPOINT, {
				method: "POST", headers, signal, redirect: "error",
				body: JSON.stringify({
					id: this.id,
					model: this.options.model ?? process.env.PI_CODEX_WEB_SEARCH_MODEL ?? "gpt-5.4",
					commands: {
						search_query: input.search_query, open: input.open, find: input.find, click: input.click,
						response_length: input.response_length ?? "short",
					},
					settings: {
						external_web_access: mode === "indexed" ? "indexed" : mode === "live",
						allowed_callers: ["direct"],
						...(input.allowed_domains ? { filters: { allowed_domains: input.allowed_domains } } : {}),
					},
				}),
			});
			if (!response.ok) {
				await response.body?.cancel();
				const hint = response.status === 401 ? " Run codex login to renew your session."
					: response.status === 429 ? " Search is rate limited; try later."
					: " The standalone search endpoint may be unavailable for this account or Codex version.";
				throw new SearchError(`Codex web search failed (HTTP ${response.status}).${hint} Private response details were withheld.`);
			}
			const data: unknown = JSON.parse(await readBoundedBody(response));
			if (!data || typeof data !== "object" || !("output" in data) || typeof data.output !== "string") {
				throw new SearchError("Codex web search returned an unsupported response; private response details were withheld.");
			}
			// encrypted_output and opaque result DTOs are intentionally excluded.
			return { output: data.output, mode };
		} catch (error) {
			if (error instanceof SearchError) throw error;
			if (timeout.aborted) throw new SearchError("Codex web search timed out.");
			if (signal.aborted) throw new SearchError("Codex web search was cancelled.");
			throw new SearchError("Codex web search failed. Check Codex login and connectivity locally; private diagnostics were withheld.");
		} finally {
			await client?.close();
		}
	}
}

function accountIdFromToken(token: string): string | undefined {
	try {
		const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
		const id: unknown = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof id === "string" ? id : undefined;
	} catch {
		return undefined;
	}
}

async function readBoundedBody(response: Response): Promise<string> {
	if (!response.body) throw new SearchError("Codex web search returned an empty response.");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) throw new SearchError("Web search response is too large. Narrow the request or use response_length: short.");
			chunks.push(value);
		}
		return Buffer.concat(chunks).toString("utf8");
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
