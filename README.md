# pi-codex-connectors

Pi extension: use every Codex (ChatGPT) connector you have connected — GitHub, Gmail, Google Calendar/Drive, Slack, Linear, Figma, ... — from any pi model.

## How it works

1. Starts `codex app-server` (stdio) on first use. Codex keeps owning your login and connector credentials.
2. Opens an ephemeral, model-free Codex thread with only the apps feature on; your own Codex MCP servers are disabled for it.
3. `app/installed` + `mcpServerStatus/list` build the catalog of connected connectors and their tools.
4. Tools run through `mcpServer/tool/call`. No Codex model turn runs.

The model gets three tools instead of hundreds of schemas:

| Tool | Purpose |
|---|---|
| `codex_connectors` | List connectors; with `connector`/`query`, list matching tools |
| `codex_connector_schema` | Full description and input schema of one tool |
| `codex_connector_call` | Run a tool with JSON arguments |

`/codex-connectors [refresh]` shows the catalog.

## Writes

Tools not annotated read-only need approval. `PI_CODEX_CONNECTORS_WRITES`:

- `ask` (default): confirm dialog in the TUI; denied when there is no UI (print/JSON mode)
- `allow`: run without asking
- `deny`: never run

## Setup

```bash
codex login            # ChatGPT account with connectors connected
pi install /path/to/pi-codex-connectors
```

`PI_CODEX_CONNECTORS_CODEX` overrides the Codex executable.

## Tests

Integration and scenario tests only; they use the real Codex app-server and your Codex login. No model tokens: pi scenarios use a scripted model (`integration/fixtures/scripted-model.ts`).

Use a dedicated, minimally privileged account for public CI. Tests keep connector responses in memory, drain child-process diagnostics, and report fixed failure labels rather than account data. Do not upload raw Pi transcripts or Codex diagnostics. Pi scenarios allowlist GitHub and set an explicit write policy. The test runner uses the development Pi host patched by `make setup`; `PI_BIN` can override it.

```bash
make setup   # install and patch the development Pi host
make check   # typecheck
make test    # integration/Makefile: test-connectors, test-pi, test-rpc
```

## Privacy and safety

Connector names, schemas and results enter the selected Pi model's context. Pi and the model provider may retain them. Codex owning credentials does not keep connector results within Codex.

Before discovery, the extension asks for session consent. Headless runs must explicitly set `PI_CODEX_CONNECTORS_DATA=allow`; `deny` blocks access. Concurrent discovery shares one consent prompt. Session changes close the previous connector process and require fresh consent. Consent covers the session, including model changes: use only trusted models throughout it.

Optionally restrict discovery and calls with `PI_CODEX_CONNECTORS_ALLOW=GitHub` (comma-separated exact connector names or IDs). An empty value exposes no connectors. Without this setting all enabled, callable connectors are eligible. Read-only annotations are provider hints, not an independent authorization boundary.

Write approvals reject arguments over 2000 characters rather than hiding fields. `WRITES=allow` explicitly bypasses approval; use it only in trusted automation. Destructive tools require write approval even if also marked read-only.

Large results are truncated in memory, never saved by this extension. Narrow queries or paginate to retrieve more. Existing files from older versions are not removed automatically.

App-server errors, startup diagnostics, tool-catalog errors, and failed tool responses withhold raw details because they can contain local configuration or private data. The extension discards stderr instead of retaining it. Check Codex or the connected app locally when troubleshooting; never paste raw diagnostics into a public issue. Successful connector responses still enter the selected model's context as described above.

The app-server protocol has no per-call cancellation method for connector calls. An abort, timeout or disconnect after dispatch reports an **unknown outcome**, not a cancelled action. Affected writes block further writes for the service lifetime, including refresh. Check the connected app before restarting the session; never automatically retry an uncertain write. This is not durable idempotency across restarts.

## Publishing

Run typechecking, live scenarios, `npm audit`, secret scanning and `npm pack --dry-run` before release. The package contains only source, README, license and package metadata. Publish a sanitized snapshot in a new repository when existing Git history contains private metadata; a cleanup commit does not remove historical disclosures.

Before publishing, confirm that every contributor has the right to release their contributions. Export only the reviewed source, tests, build files and license into a new directory; exclude `.git`, local configuration, logs, audit reports and dependency directories. Review and scan that export, then initialize a fresh repository using an approved public author identity. Keep the original repository private. This avoids rewriting or force-pushing its history.

The extension has no runtime import of Pi's SDK; Pi SDK peer dependencies are optional type contracts. Keep your separately installed Pi host patched. Development setup explicitly patches Pi's upstream shrinkwrapped `brace-expansion` to 5.0.12. `make check` verifies the actual resolved version, because the root lockfile audit alone can miss the upstream shrinkwrap. Re-run `make setup` after any clean install.

## License

MIT. See [LICENSE](LICENSE).
