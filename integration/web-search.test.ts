/** Offline protocol and privacy regressions: synthetic auth, intercepted search HTTP. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, it, mock } from "node:test";
import { CodexWebSearch, searchMode } from "../src/web-search.ts";

const command = fileURLToPath(new URL("./fixtures/search-auth.mjs", import.meta.url));
const query = { search_query: [{ q: "public documentation" }] };
afterEach(() => mock.restoreAll());

it("sends only retrieval commands, mode settings, and in-memory auth; reuses reference scope", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-web-protocol-"));
	const log = join(folder, "methods");
	const requests: Array<{ body: Record<string, any>; init: RequestInit }> = [];
	mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
		assert.equal(url, "https://chatgpt.com/backend-api/codex/alpha/search");
		requests.push({ body: JSON.parse(init.body as string), init });
		return Response.json({ output: "Public result https://example.com [turn0search0]", encrypted_output: "SYNTHETIC_CIPHERTEXT", results: [] });
	});
	const service = new CodexWebSearch({ mode: "live", command, env: { ...process.env, PI_WEB_TEST_RPC_LOG: log } });
	try {
		for (const mode of ["cached", "indexed", "live"] as const) {
			const result = await service.search({ ...query, mode, allowed_domains: ["example.com"] });
			assert.deepEqual(Object.keys(result).sort(), ["mode", "output"]);
			assert.ok(!JSON.stringify(result).includes("SYNTHETIC"));
		}
		await service.search({ open: [{ ref_id: "turn0search0" }] });
		assert.deepEqual(requests.map(({ body }) => body.settings.external_web_access), [false, "indexed", true, true]);
		assert.equal(new Set(requests.map(({ body }) => body.id)).size, 1);
		for (const { body, init } of requests) {
			assert.deepEqual(Object.keys(body).sort(), ["commands", "id", "model", "settings"]);
			assert.equal(init.redirect, "error");
			assert.equal(init.method, "POST");
			const headers = init.headers as Record<string, string>;
			assert.ok(headers.authorization.startsWith("Bearer synthetic."));
			assert.equal(headers["chatgpt-account-id"], "SYNTHETIC_ACCOUNT");
		}
		assert.deepEqual(requests[0]!.body.settings.filters, { allowed_domains: ["example.com"] });
		assert.deepEqual(requests[3]!.body.commands.open, [{ ref_id: "turn0search0" }]);
		assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), Array(4).fill(["initialize", "getAuthStatus"]).flat());
		const next = new CodexWebSearch({ mode: "cached", command });
		try {
			await next.search(query);
			assert.notEqual(requests[0]!.body.id, requests[4]!.body.id, "new sessions need a fresh reference scope");
		} finally { await next.close(); }
	} finally { await service.close(); rmSync(folder, { recursive: true, force: true }); }
});

it("blocks disabled and broader modes before starting auth or HTTP", async () => {
	const http = mock.method(globalThis, "fetch", () => { throw new Error("HTTP must not run"); });
	for (const [maximum, requested] of [["disabled", undefined], ["cached", "indexed"], ["cached", "live"], ["indexed", "live"]] as const) {
		const service = new CodexWebSearch({ mode: maximum, command: "/nonexistent-codex" });
		try { await assert.rejects(service.search({ ...query, mode: requested }), /disabled|exceeds/); }
		finally { await service.close(); }
	}
	assert.equal(http.mock.callCount(), 0);
	assert.throws(() => searchMode("fullfreedom"), /Invalid web search mode/);
	assert.equal(searchMode(undefined), "cached");
});

it("rejects empty requests without authentication", async () => {
	const service = new CodexWebSearch({ mode: "cached", command: "/nonexistent-codex" });
	try { await assert.rejects(service.search({}), /at least one/); } finally { await service.close(); }
});

it("requires ChatGPT login and never sends anonymous HTTP", async () => {
	const http = mock.method(globalThis, "fetch", () => { throw new Error("HTTP must not run"); });
	const service = new CodexWebSearch({ mode: "cached", command, env: { ...process.env, PI_WEB_TEST_AUTH: "missing" } });
	try { await assert.rejects(service.search(query), /codex login/); } finally { await service.close(); }
	assert.equal(http.mock.callCount(), 0);
});

it("withholds raw backend errors, does not retry, and never falls back to inference", async () => {
	for (const status of [401, 403, 429, 500]) {
		const http = mock.method(globalThis, "fetch", async () => new Response("SYNTHETIC_PRIVATE_RESPONSE", { status }));
		const service = new CodexWebSearch({ mode: "cached", command });
		try {
			await assert.rejects(service.search(query), (error: Error) => {
				assert.ok(error.message.includes(`HTTP ${status}`));
				assert.ok(!error.message.includes("SYNTHETIC"));
				return true;
			});
			assert.equal(http.mock.callCount(), 1);
		} finally { await service.close(); mock.restoreAll(); }
	}
});

it("bounds response memory and withholds malformed responses and transport diagnostics", async () => {
	for (const response of [
		() => Response.json({ output: "x".repeat(2 * 1024 * 1024 + 1) }),
		() => new Response("SYNTHETIC_INVALID_JSON"),
		() => Response.json({ output: { secret: "SYNTHETIC_PRIVATE_RESPONSE" } }),
		() => { throw new Error("SYNTHETIC_PRIVATE_NETWORK_DETAIL"); },
	]) {
		mock.method(globalThis, "fetch", async () => response());
		const service = new CodexWebSearch({ mode: "cached", command });
		try {
			await assert.rejects(service.search(query), (error: Error) => {
				assert.ok(!error.message.includes("SYNTHETIC")); return true;
			});
		} finally { await service.close(); mock.restoreAll(); }
	}
});

it("cancels an in-flight request on close and prevents reuse of old session references", async () => {
	let started!: () => void;
	const dispatch = new Promise<void>((resolve) => { started = resolve; });
	mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
		started();
		return new Promise<Response>((_resolve, reject) => {
			init.signal!.addEventListener("abort", () => reject(new Error("SYNTHETIC_ABORT_DETAIL")), { once: true });
		});
	});
	const service = new CodexWebSearch({ mode: "cached", command });
	const result = assert.rejects(service.search(query), /cancelled/);
	await dispatch;
	await service.close();
	await result;
	await assert.rejects(service.search(query), /cancelled/);
});

it("honors an already-aborted caller before auth and enforces timeouts", async () => {
	const service = new CodexWebSearch({ mode: "cached", command });
	await assert.rejects(service.search(query, AbortSignal.abort()), /cancelled/);
	await service.close();
	mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
		if (init.signal!.aborted) reject(new Error("aborted"));
		else init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
	}));
	const timed = new CodexWebSearch({ mode: "cached", command, timeoutMs: 500 });
	try { await assert.rejects(timed.search(query), /timed out/); } finally { await timed.close(); }
});

it("the request timeout also cancels a stalled app-server initialization", async () => {
	const service = new CodexWebSearch({ mode: "cached", command, timeoutMs: 200,
		env: { ...process.env, PI_WEB_TEST_AUTH: "stall" } });
	const started = Date.now();
	try { await assert.rejects(service.search(query), /timed out/); } finally { await service.close(); }
	assert.ok(Date.now() - started < 5000, "startup ignored the request deadline");
});
