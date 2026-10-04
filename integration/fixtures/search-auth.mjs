#!/usr/bin/env node
// Synthetic app-server protocol peer. No real login, files, or network access.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const payload = Buffer.from(JSON.stringify({
	"https://api.openai.com/auth": { chatgpt_account_id: "SYNTHETIC_ACCOUNT" },
})).toString("base64url");

for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line);
	if (!request.id) continue;
	if (process.env.PI_WEB_TEST_RPC_LOG) appendFileSync(process.env.PI_WEB_TEST_RPC_LOG, `${request.method}\n`);
	let result;
	if (request.method === "initialize") {
		if (process.env.PI_WEB_TEST_AUTH === "stall") continue;
		result = {};
	}
	else if (request.method === "getAuthStatus") result = {
		authMethod: process.env.PI_WEB_TEST_AUTH === "missing" ? null : "chatgpt",
		authToken: process.env.PI_WEB_TEST_AUTH === "missing" ? null : `synthetic.${payload}.SYNTHETIC_SECRET`,
	};
	else {
		process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32601, message: "Unexpected RPC" } }) + "\n");
		continue;
	}
	process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
}
