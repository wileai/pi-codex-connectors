import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Minimal JSON-RPC client for `codex app-server --listen stdio://`.
 *
 * Messages are newline-delimited JSON objects. Requests carry `id` + `method`,
 * responses carry `id` + `result`/`error`, notifications carry only `method`.
 * The server can also send requests to the client (approvals, elicitations).
 */

type Pending = {
	method: string;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	cleanup: () => void;
};

type RpcMessage = {
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code?: number; message?: string; data?: unknown };
};

export type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown>;

export interface AppServerOptions {
	command: string;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	onServerRequest?: ServerRequestHandler;
}

export interface RequestOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

export class OutcomeUnknownError extends Error {
	constructor(reason: string) {
		super(`${reason}. Connector outcome unknown: it may still complete. Do not retry a write; verify its state in the connected app first.`);
	}
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class AppServerClient {
	readonly pid: number | undefined;
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<number, Pending>();
	private readonly onServerRequest: ServerRequestHandler | undefined;
	private nextId = 0;
	private exited: Error | undefined;
	private readonly exitWaiters: Array<() => void> = [];

	private constructor(child: ChildProcessWithoutNullStreams, onServerRequest: ServerRequestHandler | undefined) {
		this.child = child;
		this.pid = child.pid;
		this.onServerRequest = onServerRequest;
	}

	static async start(options: AppServerOptions): Promise<AppServerClient> {
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(options.command, ["app-server", "--listen", "stdio://"], {
				cwd: options.cwd,
				env: options.env ?? process.env,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch {
			throw new Error("Codex app-server failed to start. Check the executable and configuration locally; private diagnostics were withheld.");
		}
		const client = new AppServerClient(child, options.onServerRequest);
		client.attach();
		try {
			await client.request("initialize", {
				clientInfo: { name: "pi_codex_connectors", title: "pi Codex connectors", version: "0.1.0" },
				capabilities: { experimentalApi: true },
			});
			client.notify("initialized", {});
			return client;
		} catch (error) {
			await client.close();
			throw error;
		}
	}

	get isAlive(): boolean {
		return this.exited === undefined;
	}

	request<T>(method: string, params: unknown, options: RequestOptions = {}): Promise<T> {
		if (this.exited) return Promise.reject(this.exited);
		if (options.signal?.aborted) return Promise.reject(new Error(`${method} was aborted`));
		const id = ++this.nextId;
		return new Promise<T>((resolve, reject) => {
			const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			const timer = setTimeout(() => {
				this.pending.get(id)?.cleanup();
				this.pending.delete(id);
				const reason = `Codex app-server did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`;
				reject(method === "mcpServer/tool/call" ? new OutcomeUnknownError(reason) : new Error(reason));
			}, timeoutMs);
			const onAbort = () => {
				this.pending.get(id)?.cleanup();
				this.pending.delete(id);
				reject(method === "mcpServer/tool/call" ? new OutcomeUnknownError(`${method} was aborted after dispatch`) : new Error(`${method} was aborted`));
			};
			options.signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(id, {
				method,
				resolve: (value) => resolve(value as T),
				reject,
				cleanup: () => {
					clearTimeout(timer);
					options.signal?.removeEventListener("abort", onAbort);
				},
			});
			this.write({ id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		if (!this.exited) this.write({ method, params });
	}

	/** Close stdin, then escalate to SIGTERM/SIGKILL if the server does not exit. */
	async close(): Promise<void> {
		if (this.exited) return;
		const exited = new Promise<void>((resolve) => this.exitWaiters.push(resolve));
		this.child.stdin.end();
		const term = setTimeout(() => this.child.kill("SIGTERM"), 500);
		const kill = setTimeout(() => this.child.kill("SIGKILL"), 3000);
		await exited;
		clearTimeout(term);
		clearTimeout(kill);
	}

	private attach(): void {
		// Diagnostics can contain config values, credentials and local paths. Drain without retaining them.
		this.child.stderr.resume();
		this.child.stdin.on("error", () => {
			// Reported through the exit handler.
		});
		createInterface({ input: this.child.stdout, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
			this.handleLine(line);
		});
		const onGone = (reason: string) => {
			if (this.exited) return;
			this.exited = new Error(`Codex app-server ${reason}. Check Codex locally; private diagnostics were withheld.`);
			for (const pending of this.pending.values()) {
				pending.cleanup();
				pending.reject(pending.method === "mcpServer/tool/call" ? new OutcomeUnknownError("Codex app-server disconnected") : this.exited);
			}
			this.pending.clear();
			for (const resolve of this.exitWaiters.splice(0)) resolve();
		};
		this.child.on("error", () => onGone("failed to start"));
		this.child.on("exit", (code, signal) => onGone(`exited (${signal ?? `code ${code}`})`));
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;
		let message: RpcMessage;
		try {
			message = JSON.parse(line) as RpcMessage;
		} catch {
			return;
		}
		if (message.method !== undefined && message.id !== undefined) {
			void this.answerServerRequest(message.id, message.method, message.params);
			return;
		}
		if (message.method !== undefined || typeof message.id !== "number") return;
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		pending.cleanup();
		if (message.error) {
			// Use only known protocol classifications, never arbitrary server messages or data.
			const category = message.error.code === -32601 ? "method unavailable"
				: message.error.code === -32602 ? "invalid parameters"
				: "request rejected";
			pending.reject(new Error(`Codex app-server ${pending.method} failed (${category}). Check Codex locally; private diagnostics were withheld.`));
		} else {
			pending.resolve(message.result);
		}
	}

	private async answerServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
		try {
			if (!this.onServerRequest) throw new Error(`Unsupported server request ${method}`);
			const result = await this.onServerRequest(method, params);
			this.write({ id, result });
		} catch {
			this.write({ id, error: { code: -32601, message: "Client could not handle the server request; private diagnostics were withheld." } });
		}
	}

	private write(message: RpcMessage): void {
		if (this.exited) return;
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}
}
