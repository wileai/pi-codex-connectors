# @wileai/pi-codex-connector

Pi extension: use your connected Codex (ChatGPT) apps and direct web search from any Pi model.

Website: https://wileai.github.io/pi-codex-connectors/

## How it works

1. Starts `codex app-server` (stdio) on first use. Codex keeps owning your login and connector credentials.
2. Opens an ephemeral, model-free Codex thread with only the apps feature on; your own Codex MCP servers are disabled for it.
3. `app/installed` + `mcpServerStatus/list` build the catalog of connected connectors and their tools.
4. Tools run through `mcpServer/tool/call`. No Codex model turn runs.

Connector access uses three tools instead of hundreds of schemas:

| Tool | Purpose |
|---|---|
| `codex_connectors` | List connectors; with `connector`/`query`, list matching tools |
| `codex_connector_schema` | Full description and input schema of one tool |
| `codex_connector_call` | Run a tool with JSON arguments |

`/codex-connectors [refresh]` shows the catalog.

## Direct web search

`codex_web_search` searches and reads the public web through Codex's standalone `alpha/search` endpoint. It never starts a Codex model turn or calls the Responses API. The endpoint requires a `model` routing field; this does not start inference in this extension. Backend processing and billing are not established by the response.

The extension asks `codex app-server` for your ChatGPT access token using `getAuthStatus`, keeps it in memory for the request, and sends it only to the fixed HTTPS search endpoint. Codex owns login and credential storage; the extension does not read `auth.json`, implement OAuth, or save tokens. Redirects are rejected. **Unlike connector calls, direct web search handles an access token in the extension process.**

This is an internal alpha endpoint, verified with Codex CLI 0.160.0. Its availability and schema can change. Search failure never falls back to a model turn. Use `PI_CODEX_CONNECTORS_CODEX` if your Codex executable is not on PATH. Both a standalone CLI and the desktop app's bundled CLI can supply authentication.

### Access modes

Set the initial maximum with `PI_CODEX_WEB_SEARCH_MODE`, or change it for this Pi session with `/codex-web-search cached`, `/codex-web-search indexed`, `/codex-web-search live`, or `/codex-web-search disabled`.

| Mode | Requested backend access |
|---|---|
| `disabled` | No search requests |
| `cached` (default) | Cached results; `external_web_access: false` |
| `indexed` | External access gated by the search index; `external_web_access: "indexed"` |
| `live` | Live retrieval; `external_web_access: true` |

The tool's optional `mode` can narrow this maximum, never exceed it. For example, a session set to `indexed` rejects a tool request for `live`. Only the user command or startup environment selects broader access. Changing modes clears result references but retains saved permissions.

These are hosted retrieval modes, **not local shell sandbox permissions**. They do not grant access to local files, a signed-in browser, or arbitrary shell commands. The extension has its own mode setting; it does not inherit Codex's `web_search` config or local command network rules. `allowed_domains` is a backend search filter, not a local network firewall. See [OpenAI's web search documentation](https://learn.chatgpt.com/docs/web-search) and the [Codex mode mapping](https://github.com/openai/codex/blob/main/codex-rs/ext/web-search/src/extension.rs).

### Tool arguments

At least one of `search_query`, `open`, `find`, or `click` is required. Each accepts up to four operations:

```json
{"search_query":[{"q":"Codex web search documentation","domains":["developers.openai.com"]}],"response_length":"short"}
```

```json
{"open":[{"ref_id":"turn0search0"}]}
```

```json
{"find":[{"ref_id":"turn0search0","pattern":"web search"}]}
```

```json
{"click":[{"ref_id":"turn0view0","id":12}]}
```

Use actual `ref_id` and link IDs returned by the previous call, or a URL for `open`/`find`. References last for the current Pi session and search mode. A resumed or switched session starts fresh. `response_length` accepts `short` (default), `medium`, or `long`. Queries can include `recency` in days; `allowed_domains` applies a backend domain filter to the request. Cite the returned source URLs in answers.

Search consent is remembered for the Pi user. Accept the initial prompt once, or use `/codex-permissions web allow`. Headless use accepts saved approval or `PI_CODEX_WEB_SEARCH_DATA=allow`. Queries and requested URLs go to OpenAI, and results enter the selected Pi model's context. Conversation history is not sent. Results are bounded in memory; tokens, encrypted payloads, and raw error bodies are excluded from tool results. Returned web content remains untrusted.

`PI_CODEX_WEB_SEARCH_MODEL` overrides the endpoint's routing field (default `gpt-5.4`); it does not select the Pi model. On authentication failure, renew your login with `codex login`. The extension never changes your login automatically.

### Try a local checkout

From the checkout containing this change:

```bash
PI_CODEX_WEB_SEARCH_MODE=indexed pi --no-extensions --extension ./src/index.ts
```

This loads the checkout for one run, avoiding duplicate tools from an installed version. Accept the search consent prompt once, then ask: “Use codex_web_search to find Codex web search documentation, open a result, and cite its URL.” Use `/codex-web-search live` to try live retrieval. No npm installation is needed; accepting consent saves your permission choice.

## Remember permissions for the whole extension

Run once in Pi to stop extension approval prompts, **including connected-app writes**:

```text
/codex-permissions all allow
```

The choice survives restarts, new sessions, projects, model changes, and search-mode changes for the same Pi user directory. To restore prompts, run `/codex-permissions all ask`; to block access, use `/codex-permissions all deny`. Run `/codex-permissions` without arguments to show effective policies.

More selective choices are available:

```text
/codex-permissions data allow
/codex-permissions writes ask
```

`data` covers connector data and web search. Individual scopes are `connectors`, `web`, and `writes`; each accepts `allow`, `ask`, or `deny`. Accepting a data-consent dialog automatically remembers that scope; approving an individual write does not silently authorize future writes. Saved `writes: allow` also accepts connector confirmation forms that require no additional input. Provider login flows and forms requiring input still need the provider's normal interaction.

Only these policy values are saved to `~/.pi/agent/codex-connectors-permissions.json` (or the directory selected by `PI_CODING_AGENT_DIR`). The file contains no tokens, queries, or results. It is written atomically with owner-only permissions. No project-local permission file is read.

Explicit `PI_CODEX_CONNECTORS_DATA`, `PI_CODEX_WEB_SEARCH_DATA`, and `PI_CODEX_CONNECTORS_WRITES` environment values override saved preferences. `ask` retains session data-consent prompts or per-action write prompts; `deny` blocks access. Unset an override to use your saved choice. Missing preferences default to `ask`. Permission changes apply to subsequent calls; they cannot undo a request already sent.

## Writes

Tools not annotated read-only follow the saved `writes` policy or the `PI_CODEX_CONNECTORS_WRITES` override:

- `ask` (default): confirm dialog in the TUI; denied when there is no UI (print/JSON mode)
- `allow`: run without asking
- `deny`: never run

## Setup

```bash
codex login            # ChatGPT account with connectors connected
pi install npm:@wileai/pi-codex-connector
```

Requires Node.js 22.19+ and Pi. This package is a Pi extension, not a standalone MCP server; other harnesses must support loading Pi extensions.

Alternatively, add the package to the existing `packages` array in `~/.pi/agent/settings.json` (personal) or `.pi/settings.json` (project):

```json
{
  "packages": ["npm:@wileai/pi-codex-connector"]
}
```

Project settings require Pi project trust. Restart Pi after installation or updating.

```bash
pi update npm:@wileai/pi-codex-connector  # update this extension
pi update --extensions            # update all packages on current Pi
```

Keep the npm source unversioned to receive stable updates. An explicit version such as `npm:@wileai/pi-codex-connector@0.1.1` stays pinned. Releases become available through npm; users choose when to update.

### Migrating from the original npm name

The package is now `@wileai/pi-codex-connector`. Existing installs of the old name need a one-time migration:

```bash
pi remove npm:pi-codex-connectors
pi install npm:@wileai/pi-codex-connector
```

Use `--local` on both commands for a project-local installation. Restart Pi afterward. Future updates use `pi update npm:@wileai/pi-codex-connector`.

`PI_CODEX_CONNECTORS_CODEX` overrides the Codex executable.

## Tests

Connector integration and scenario tests use the real Codex app-server and your Codex login. Pi scenarios use a scripted model (`integration/fixtures/scripted-model.ts`), so they do not run model inference. Web-search protocol tests use synthetic auth and intercepted HTTP; live retrieval tests separately exercise the real endpoint with public queries. Backend search accounting is not established by these tests.

Use a dedicated, minimally privileged account for public CI. Tests keep connector responses in memory, drain child-process diagnostics, and report fixed failure labels rather than account data. Do not upload raw Pi transcripts or Codex diagnostics. Pi scenarios allowlist GitHub and set an explicit write policy. The test runner uses the development Pi host patched by `make setup`; `PI_BIN` can override it.

```bash
make setup   # install and patch the development Pi host
make check   # typecheck
make test    # integration/Makefile: test-connectors, test-pi, test-rpc
make test-web-search       # offline protocol, privacy, and access-control checks
make test-web-search-live  # real retrieval + real Pi scenarios; requires codex login
```

## Privacy and safety

Connector names, schemas and results enter the selected Pi model's context. Pi and the model provider may retain them. Codex owning credentials does not keep connector results within Codex.

Before discovery, the extension checks saved user consent or the environment override. Headless runs use saved approval or `PI_CODEX_CONNECTORS_DATA=allow`; `deny` blocks access. Concurrent discovery shares one consent prompt. Session changes close the previous connector process and retain saved approval. Saved consent covers future sessions and model changes: use trusted models, or revoke it with `/codex-permissions connectors ask`.

Optionally restrict discovery and calls with `PI_CODEX_CONNECTORS_ALLOW=GitHub` (comma-separated exact connector names or IDs). An empty value exposes no connectors. Without this setting all enabled, callable connectors are eligible. Read-only annotations are provider hints, not an independent authorization boundary.

In `ask` mode, write approvals reject arguments over 2000 characters rather than hiding fields. Saved `writes: allow` or `PI_CODEX_CONNECTORS_WRITES=allow` bypasses approval. Destructive tools follow the write policy even if also marked read-only.

Large results are truncated in memory, never saved by this extension. Narrow queries or paginate to retrieve more. Existing files from older versions are not removed automatically.

App-server errors, startup diagnostics, tool-catalog errors, and failed tool responses withhold raw details because they can contain local configuration or private data. The extension discards stderr instead of retaining it. Check Codex or the connected app locally when troubleshooting; never paste raw diagnostics into a public issue. Successful connector responses still enter the selected model's context as described above.

The app-server protocol has no per-call cancellation method for connector calls. An abort, timeout or disconnect after dispatch reports an **unknown outcome**, not a cancelled action. Affected writes block further writes for the service lifetime, including refresh. Check the connected app before restarting the session; never automatically retry an uncertain write. This is not durable idempotency across restarts.

## Publishing

See [RELEASING.md](https://github.com/wileai/pi-codex-connectors/blob/main/RELEASING.md) for initial npm setup and the release checklist. Publishing a GitHub release triggers `.github/workflows/publish.yml`: it checks the release version, typechecks, audits runtime dependencies, verifies the package contents, and publishes with provenance. Stable releases use npm's `latest` tag; prereleases use `next`.

The `pi-package` keyword and `pi.extensions` manifest make the published package eligible for the [Pi package catalog](https://pi.dev/packages). Catalog indexing is external and may lag publication.

The extension has no runtime import of Pi's SDK; Pi SDK peer dependencies are optional type contracts. Keep your separately installed Pi host patched. Development setup explicitly patches Pi's upstream shrinkwrapped `brace-expansion` to 5.0.12. `make check` verifies the actual resolved version, because the root lockfile audit alone can miss the upstream shrinkwrap. Re-run `make setup` after any clean install.

## License

MIT. See [LICENSE](LICENSE).

## Computer Use (macOS)

Computer Use tools load automatically with this extension when the desktop runtime
is available. Start Pi normally; no enable flag is needed.

Requires a locally installed ChatGPT desktop app with its Computer Use runtime and
macOS permissions. Set `PI_CODEX_COMPUTER_APP` if the app is not at
`/Applications/ChatGPT.app`. This is an experimental integration with internal
runtime interfaces that may change between desktop releases.

The tools `mcp__codex_computer__js` and `mcp__codex_computer__js_reset` run persistent
JavaScript using `@oai/sky`. The desktop launcher starts the runtime with a Sky-only
bootstrap; the `cua` API is not loaded. Desktop actions do not start another Codex
model turn. Your selected Pi model still reasons about results and receives app
content and screenshots.

Try: **Use @oai/sky to calculate 125 × 8, then 360 ÷ 8 in Calculator. Verify each
result from the app.**

Each app requests access with **Yes, for this session**, **Yes, forever**, or **No**.
Forever is offered only when native policy permits persistence. Session grants
reset with the Pi session; forever grants are stored locally in
`computer-use-approvals.json` in your Pi agent directory. `/codex-computer forget`
clears both. Native app restrictions remain enforced. Headless requests need a
previously saved grant; otherwise they are declined. App access does not authorize
sending messages, deleting data, or other actions outside your requested task.

`/codex-computer` displays the installed runtime version. When the runtime is
unavailable, it explains what is missing;
connectors and web search remain available. App approvals are still required and
do not affect connector/web-search permissions.
