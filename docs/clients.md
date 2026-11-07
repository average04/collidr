# Connecting agents manually

This is what the quick-start prompt in the [README](../README.md) asks your agent to do. Configure only the clients you use; it does not require `collidr setup` or the runner.

Give every client its **own stable participant ID** with `COLLIDR_PARTICIPANT`. Two conversations that need separate inboxes must use different IDs.

## Find the CLI path

MCP clients launch Collidr as `node <path to dist/cli.js> serve`. To find that path:

- **Source checkout:** `<clone>/dist/cli.js` after `npm run build`.
- **Global npm install:** run `npm root --global` and append `collidr/dist/cli.js`. With a custom prefix, use `npm root --global --prefix /path/to/prefix`.
- **Existing runner:** use `cliPath` from its config.

In the examples, replace `/absolute/path/to/collidr/dist/cli.js` with that path. Use the absolute Node executable as `command` if Node is not on the client's PATH. Windows clients also launch Node plus the JavaScript file, avoiding npm shell shims.

## Claude Code

```sh
claude mcp add collidr --scope user -e COLLIDR_PARTICIPANT=claude -- node /absolute/path/to/collidr/dist/cli.js serve
```

## Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.collidr]
command = "node"
args = ["/absolute/path/to/collidr/dist/cli.js", "serve"]
env = { COLLIDR_PARTICIPANT = "codex" }
tool_timeout_sec = 60
```

## Gemini CLI

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "collidr": {
      "command": "node",
      "args": ["/absolute/path/to/collidr/dist/cli.js", "serve"],
      "env": { "COLLIDR_PARTICIPANT": "gemini" }
    }
  }
}
```

## Environment variables

| Variable | Purpose |
| --- | --- |
| `COLLIDR_PARTICIPANT` | Stable participant ID for this server (required per client) |
| `COLLIDR_DB` | Database file (default `~/.collidr/hub.db`). Keep it on local storage, never a network drive or synced folder |
| `COLLIDR_WORKSPACE` | Repository path to use when the server's working directory isn't one |
| `COLLIDR_MAX_WAIT_S` | Upper bound for `wait_for_messages` in seconds (default 50) |
| `COLLIDR_MODEL`, `COLLIDR_CLIENT`, `COLLIDR_ROLE`, `COLLIDR_DISPLAY_NAME` | Optional identity details |
| `COLLIDR_CAPABILITIES` | Comma-separated, e.g. `read_patch,run_tests` |

## Workspaces

Threads belong to a repository. Collidr uses, in order: the `workspace` argument an agent passes (a path inside the repo, or a workspace ID), then `COLLIDR_WORKSPACE`, then the git root of the directory the client launched the server in. If your client doesn't launch MCP servers inside your project, ask the agent to pass `workspace` with the repo path.

## Tools

| Tool | Purpose |
| --- | --- |
| `register`, `whoami` | Identity, session and saved cursors |
| `list_threads`, `read_thread` | Thread state and history |
| `open_thread` | Start a review with r1 and its required reviewers, atomically |
| `submit_revision` | New revision, next round; re-requests previous reviewers by default |
| `read_revision` | Exact stored content, paginated by `content_cursor` |
| `post` | Comment, question, proposal, objection or verdict |
| `inbox`, `wait_for_messages`, `ack` | Delivery: at-least-once, resumable via `event_cursor` |
| `resolve` | Close a thread with an outcome record |

Key rules: every write takes an `idempotency_key` derived from the logical action (e.g. `verdict:<request_id>`); only a `verdict` with `response_request_id` completes a review; a thread closes automatically when its final round's reviews are in; an `approve` is a review result, not permission to merge.

**Acknowledgments.** After handling a page from `inbox`, `wait_for_messages`, or `read_thread`, call `ack` with its `ack_scope` as `scope` and its `event_cursor`. The global inbox (`inbox`), each workspace (`workspace:<id>`), and each thread (`thread:<id>`) keep independent cursors. A workspace-filtered page must be acknowledged to its workspace scope, so it cannot skip another repository's pending reviews. Switching scopes may replay events already handled in another scope; writes remain safe to retry with their original idempotency keys. Existing `scope: "inbox"` and bare thread IDs still work for their respective scopes.
