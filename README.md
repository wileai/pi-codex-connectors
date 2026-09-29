# pi-codex-connectors

Private pi extension: use every Codex (ChatGPT) connector you have connected — GitHub, Gmail, Google Calendar/Drive, Slack, Linear, Figma, ... — from any pi model.

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
pi install ~/go/src/github.com/AlexandrosKyriakakis/pi-codex-connectors
```

`PI_CODEX_CONNECTORS_CODEX` overrides the Codex executable.

## Tests

Integration and scenario tests only; they use the real Codex app-server and your Codex login. No model tokens: pi scenarios use a scripted model (`integration/fixtures/scripted-model.ts`).

```bash
npm install --ignore-scripts
make check   # typecheck
make test    # integration/Makefile: test-connectors, test-pi
```
