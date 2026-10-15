# MergeWarden local Codex MCP

V1 exposes the existing `src/engine/review.ts` application API over local STDIO. Pi continues to own the model/tool loop and durable session. Snapshot, evidence validation and report delivery use the existing engine. The older `src/protocol/contracts.ts` is a transport-neutral design sketch, not the implemented application entry point.

Requires Node.js 22.19+, Git and the four locked packages installed by `npm run setup`. Do not use `npm run mcp` as the configured STDIO command: npm may write its banner to stdout. Launch Node directly. STDIO stdout contains only MCP JSON-RPC; diagnostics go to stderr.

The configuration and live review workflow were tested with Codex CLI **0.159.2**. Use a current local client for the documented approval options. Desktop and IDE use the shared configuration described below; their GUI workflows have not been separately exercised.

## Configure Codex

For the packaged plugin (skill + fixed-profile launcher), follow the root [Codex plugin instructions](../../README.md#codex-plugin). The manual configuration below remains available. Enable one entry for the same checkout rather than running both the plugin and an older standalone server. The plugin's `setup`/`login` commands select the same independent Pi authentication and existing state directory; installation does not import Codex credentials.

Authenticate MergeWarden first, using its existing CLI and the same state directory:

```sh
npm run cli -- login --provider openai-codex
npm run cli -- models --provider openai-codex
```

Choose an account-accessible model from the **locked Pi catalog**. This is the review model, separate from the model selected in the Codex host. A catalog entry does not prove entitlement. Existing Codex/Pi credentials are not imported by MergeWarden.

Add a server using the current external-MCP CLI command:

```sh
codex mcp add mergewarden -- node --experimental-strip-types /absolute/MergeWarden/integrations/mcp/src/main.ts --repo /absolute/reviewed-checkout --provider openai-codex --model MODEL_ID --auth oauth
```

For a custom state directory, append `--state /absolute/state` to **both** the MergeWarden login and server commands. Windows defaults to `%LOCALAPPDATA%/MergeWarden2`; other systems use `~/MergeWarden2`, as in the original CLI. State must be outside and separate from the reviewed checkout.

Equivalent `~/.codex/config.toml` configuration (or project `.codex/config.toml` in a trusted project):

```toml
[mcp_servers.mergewarden]
command = "node"
args = [
  "--experimental-strip-types",
  "/absolute/MergeWarden/integrations/mcp/src/main.ts",
  "--repo", "/absolute/reviewed-checkout",
  "--provider", "openai-codex",
  "--model", "MODEL_ID",
  "--auth", "oauth",
]
startup_timeout_sec = 30
tool_timeout_sec = 60
required = true
```

On Windows, use forward slashes in TOML paths, for example `C:/projects/MergeWarden/integrations/mcp/src/main.ts` and `C:/projects/my-app`. If Node is not on the host's PATH, set `command` to its absolute executable path. One server is bound to one canonical checkout; use another server name/configuration for another checkout.

If your model provider requires a proxy, explicitly forward the existing environment variable names in that same server table:

```toml
env_vars = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"]
```

This uses the existing Pi network setup. For lowercase proxy variables, list their lowercase names too. Keep proxy values and credentials out of committed configuration. If API-key authentication also needs forwarding, combine all required names into one `env_vars` array.

For API-key authentication, replace `--auth oauth` with `--api-key-env MERGEWARDEN_API_KEY` and add:

```toml
env_vars = ["MERGEWARDEN_API_KEY"]
```

Set that variable in the environment from which Codex starts. Never put the key value in tool arguments, command arguments, committed config or examples. OAuth and API-key selection are mutually exclusive, with no fallback. `codex mcp login` is for an MCP server's OAuth; MergeWarden's local STDIO server instead uses the existing **MergeWarden CLI login** for its Pi model authentication.

The local desktop app, CLI and IDE share MCP configuration on the same Codex host. Restart the desktop app/IDE after adding the server; CLI `/mcp` or `codex mcp list` inspects configuration. Cloud/web workflows do not automatically gain access to a local STDIO process. See [current Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

`start_review` and `cancel_review` accurately declare local state writes, so Codex can request approval. Noninteractive `codex exec` cannot answer an approval prompt. For an explicitly authorized review through your trusted, fixed-checkout server, give only that tool an allow rule for the invocation or configuration:

```toml
[mcp_servers.mergewarden.tools.start_review]
approval_mode = "approve"
```

Interactive desktop/CLI use can approve the call in the host. This is independent of the Pi model login; changing tool annotations to conceal state writes is not necessary.

For unattended cancellation, authorize `cancel_review` separately with the same per-tool option.

## Use the five tools

Ask Codex: **“用 MergeWarden 审查当前仓库的 staged changes。”** The configured checkout must be the one you mean.

| Tool | Arguments | Result |
|---|---|---|
| `start_review` | `scope` defaults to `staged`; `commits` requires `base`/`head`; `worktree` optionally accepts `includeUntracked`; optional `timeoutMs`, `maxToolCalls`, `requestId` UUID | Quickly returns `taskId` and `accepted`; does not wait for the review |
| `get_review` | `id`: taskId or native runId; `includeReport` defaults to true | Current/terminal status; original verified Report when delivered |
| `read_evidence` | `runId`, `findingId`, `evidenceIndex` defaults to 0 | One exact frozen source page and its original EvidenceRef; `evidenceCount` tells how many references exist |
| `list_reviews` | `limit` defaults to 10, maximum 50 | Recent CLI runs and MCP tasks for this configured checkout; no duplicate run/task entry |
| `cancel_review` | `taskId` | Requests cancellation; poll to obtain the engine's final outcome |

Example tool sequence:

```text
start_review({scope: "staged", requestId: "<fresh UUID>"})
get_review({id: "<returned taskId>", includeReport: false})  // respect pollAfterMs
get_review({id: "<returned taskId>"})                       // done=true; inspect status
read_evidence({runId: "<returned runId>", findingId: "<report.findings[0].id>"})
```

Reuse `requestId` only when retrying the same uncertain start. It binds the original scope, budgets and host review configuration; another request with that UUID is rejected. Omit it to create a fresh task. Task IDs and native run IDs are distinct: the engine allocates its run only after freezing changed source. An empty change produces `no_changes` without a model session or native run.

`done` means terminal. **Only `status: completed` from the verified native report confirms a completed review.** `partial`, `failed`, `cancelled`, `delivery_failed`, `interrupted` and `no_changes` retain their distinct meanings. Status polling checks both report delivery hashes even with `includeReport: false`. `agent_end`, zero findings, an accepted task or a cancellation request cannot establish completion. Review outcomes are ordinary structured tool data; invalid inputs, inaccessible records and integrity failures use `isError: true`.

## Lifetime and boundaries

The default review budget remains ten minutes/100 tool operations; it is independent of Codex's default 60-second **individual tool call** timeout. Accepted reviews run in the server process and are queried using explicit handles. Cancelling a poll/RPC does not cancel the accepted job: use `cancel_review`. One active review per server is allowed; the existing engine repository lock also excludes concurrent CLI/other-server reviews using the same state directory.

Closing stdin, SIGINT or SIGTERM stops admission, requests engine cancellation and waits up to three seconds for cleanup. The server then exits. Reviews are not detached daemons and do not resume automatically. A forcibly killed process can leave a native running manifest and lock. A task whose owner is gone returns `interrupted`, never `completed`; inspect with CLI `doctor` and use `unlock` only after confirming that owner exited. A run queried directly without a task can have `liveness: unknown`. A task owned by another live MCP process can be queried; cancellation must go through its owning connection.

Small receipts in `STATE/mcp/tasks/<taskId>/task.json` link the handle to the existing native run, or record no-change/startup failure. They contain no report copies, sessions or credentials. Delivered artifacts and receipts remain available across restarts until the user removes their state. There is no background retention service or task recovery engine.

Concurrent polling exposed Windows sharing conflicts during atomic state replacement. The shared file helper retries the same rename up to 40 times at 25 ms; it preserves the destination and the original delivery/hash checks. Permanent file errors still fail delivery. The review engine, CLI and Pi loop are otherwise unchanged.

Repository, state, model, inference and authentication are fixed by the host startup command. Tool schemas reject overrides and expose no arbitrary-file, session, token, edit, patch, commit, push or merge operation. Source is returned only for a finding in a verified report for that checkout, through `SnapshotStore` and `checkEvidence`. State isolation resolves path/junction aliases using the existing admission checks. The existing local-state trust boundary in [SECURITY.md](../../SECURITY.md) continues to apply, including proprietary source and the absence of independent source secret scanning.

The startup option `--skills auto|off` defaults to `auto`, reading the existing frozen knowledge package. V1 sets the existing engine's `learn: off`: it performs review only and does not invoke post-review learning. Original CLI learning behavior is unchanged. There are no extra runtime/model loops, automatic fixes, hosted transport, sampling requests or UI capabilities.

## Current official interface choices

Checked against official sources on **2026-10-01**:

- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli): local STDIO configuration, shared desktop/CLI/IDE configuration, startup timeout and tool timeout. Local client capabilities do not imply remote/cloud support.
- [Codex changelog](https://learn.chatgpt.com/docs/changelog): `codex mcp-server`/`codex-mcp-server` were removed on 2026-09-05; connecting to external MCP servers with `codex mcp` continues. This adapter does not launch Codex as a server or replace Pi with an app server.
- [Official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) and [v2 migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2): locked `@modelcontextprotocol/server`/`client` 2.2.0, Zod 4.6.5, `registerTool` with schema objects and `serveStdio`. Removed variadic `.tool()` and old experimental core Tasks interception are not used.
- [Protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions): 2026-07-28 uses discovery/per-request metadata; SDK-managed STDIO also serves legacy initialize clients. The adapter does not hand-code either protocol.
- [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) and [cancellation](https://ts.sdk.modelcontextprotocol.io/v2/servers/logging-progress-cancellation): JSON `structuredContent` plus a serialized text block, explicit state handles, request-scoped admission cancellation, sanitized tool errors and server-owned job cancellation.
- [Tasks extension](https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks): Tasks moved out of core; current Codex MCP documentation does not guarantee that extension for every target client. V1 uses ordinary start/get/cancel tools and advertises no Tasks extension.
- [OpenAI MCP Extensions README](https://github.com/openai/mcp-extensions), [TypeScript examples](https://github.com/openai/mcp-extensions/blob/main/typescript/README.md) and [support matrix](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md): optional host-specific UI, entrypoints, mentions and forms layered on MCP; capabilities differ by surface and must be detected. Its current README still contains v1 SDK imports. These examples are not the dependency baseline for this v2 tool-only adapter, and no UI/Extensions support is claimed.

Run `npm --prefix integrations/mcp test` and `npm --prefix integrations/mcp run typecheck`, or the complete `npm run verify`. Offline tests cover both protocol eras, real STDIO, the actual Pi SDK/durable journal with scripted responses, cancellation/reconnect, failed/tampered delivery, frozen evidence and path/credential boundaries. Scripted responses validate plumbing, not model review quality.
