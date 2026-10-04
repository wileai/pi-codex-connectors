import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type Elicitation = { mode?: string; message: string; requestedSchema?: { type?: string; properties?: Record<string, unknown> }; _meta?: Record<string, unknown> };
export type ElicitationReply = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown>; _meta?: { persist: "always" | "session" } };
type Pending = { resolve: (result: any) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout>; timeout: number };

/** Local MCP client with explicit form-elicitation support. No native permission bypass. */
export class ComputerBridge {
	private child: ChildProcessWithoutNullStreams;
	private pending = new Map<number, Pending>();
	private nextId = 0;
	private ended = false;
	private eliciting = 0;
	private onElicitation: (request: Elicitation) => Promise<ElicitationReply>;
	private constructor(command: string, args: string[], env: NodeJS.ProcessEnv, onElicitation: (request: Elicitation) => Promise<ElicitationReply>) {
		this.onElicitation = onElicitation;
		this.child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
		this.child.stderr.resume();
		this.child.stdin.on("error", () => {});
		this.child.on("error", () => this.fail("Computer Use runtime could not start."));
		this.child.on("exit", () => this.fail("Computer Use runtime disconnected. An in-flight UI action may have completed; inspect the app before retrying."));
		createInterface({ input: this.child.stdout }).on("line", (line) => {
			let message: any;
			try { message = JSON.parse(line); } catch { return; }
			if (message.method && message.id !== undefined) { void this.answer(message); return; }
			if (message.method || typeof message.id !== "number") return;
			const pending = this.pending.get(message.id);
			if (!pending) return;
			clearTimeout(pending.timer); this.pending.delete(message.id);
			if (message.error) pending.reject(new Error("Computer Use MCP request failed; inspect the app before retrying a UI action."));
			else pending.resolve(message.result);
		});
	}
	static async start(command: string, args: string[], env: NodeJS.ProcessEnv, onElicitation: (request: Elicitation) => Promise<ElicitationReply>) {
		const bridge = new ComputerBridge(command, args, env, onElicitation);
		try {
			await bridge.request("initialize", { protocolVersion: "2025-06-18", capabilities: { elicitation: { form: {} } }, clientInfo: { name: "pi-local-computer-use", version: "0.0.2" } });
			bridge.send({ jsonrpc: "2.0", method: "notifications/initialized" });
			return bridge;
		} catch (error) { await bridge.close(); throw error; }
	}
	request(method: string, params: unknown, timeout = 60_000): Promise<any> {
		if (this.ended) return Promise.reject(new Error("Computer Use bridge is closed. Restart the Pi session."));
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			const pending = { resolve, reject, timeout };
			this.pending.set(id, pending); this.arm(pending);
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}
	private arm(pending: Pending) {
		if (this.eliciting || this.ended) return;
		pending.timer = setTimeout(() => {
			this.fail("Computer Use timed out. An action may have completed; inspect the app before retrying.");
			void this.close();
		}, pending.timeout);
	}
	private async answer(message: any) {
		if (message.method !== "elicitation/create") {
			this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported client request" } }); return;
		}
		this.eliciting++;
		for (const request of this.pending.values()) clearTimeout(request.timer);
		let result: ElicitationReply = { action: "cancel" };
		try { result = await this.onElicitation(message.params); } catch { /* Cancel, never silently approve. */ }
		this.send({ jsonrpc: "2.0", id: message.id, result });
		this.eliciting--;
		if (!this.eliciting) for (const request of this.pending.values()) this.arm(request);
	}
	private send(message: unknown) { if (!this.ended) this.child.stdin.write(JSON.stringify(message) + "\n"); }
	private fail(message: string) {
		this.ended = true;
		for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
		this.pending.clear();
	}
	async close() {
		this.fail("Computer Use stopped. Check the app before retrying any interrupted UI action.");
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		await new Promise<void>((resolve) => {
			const term = setTimeout(() => this.child.kill("SIGTERM"), 300);
			const kill = setTimeout(() => this.child.kill("SIGKILL"), 2000);
			this.child.once("close", () => { clearTimeout(term); clearTimeout(kill); resolve(); });
			this.child.stdin.end();
		});
	}
}
