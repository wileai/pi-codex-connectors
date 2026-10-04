/** Live public retrieval only; never print raw responses, auth, or local diagnostics. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { CodexWebSearch } from "../src/web-search.ts";

for (const mode of ["cached", "indexed", "live"] as const) {
	it(`standalone retrieval supports ${mode} mode and session result references`, async () => {
		const search = new CodexWebSearch({ mode });
		try {
			const result = await search.search({
				search_query: [{ q: "OpenAI Codex web search documentation" }],
				allowed_domains: ["developers.openai.com", "learn.chatgpt.com"],
			});
			assert.ok(result.output.includes("https://"), "search returned no source URL");
			const ref = /turn\d+search\d+/.exec(result.output)?.[0];
			assert.ok(ref, "search returned no reference");
			const opened = await search.search({ open: [{ ref_id: ref }] });
			assert.ok(/Content type:|Total lines:/.test(opened.output), "open did not return page content");
			const found = await search.search({ find: [{ ref_id: ref, pattern: "Codex" }] });
			assert.ok(found.output.includes("Codex"), "find did not return matching page content");
		} finally { await search.close(); }
	});
}
