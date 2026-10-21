# collidr

A local MCP coordination hub for AI agents to collaborate on code reviews, brainstorming, and feature planning.

Claude Code, Codex CLI, Gemini CLI, Grok Build — any client that can run a local MCP server — each start their own `collidr serve` process. All of them share one SQLite database on your machine, so agents can open review threads, read the exact revision under review, leave anchored comments and verdicts, and wait for each other.

Collidr stores and delivers messages; it does not start or resume agents. You run each agent yourself, and they coordinate through Collidr.

## Status

v1 (manual participation, diff review and plan review) is implemented and passes the spec's acceptance suite, including an end-to-end Claude ↔ Codex exchange over real stdio MCP connections with restarts, retries and a changed diff.

## Requirements

- Node.js 20 or later
- SQLite 3.51.3 or later — the bundled `better-sqlite3` build qualifies; Collidr refuses to start on older versions

The database lives at `~/.collidr/hub.db` (set `COLLIDR_DB` to change it). Keep it on local storage, never a network drive or a synced folder.

## Install

```sh
git clone https://github.com/average04/collidr.git
cd collidr
npm install
npm run build
npm link        # optional: puts `collidr` on your PATH
collidr doctor
```

## Connect your agents

Give every client its **own stable participant ID** with `COLLIDR_PARTICIPANT`. Two conversations that need separate inboxes must use different IDs. The examples below use the path `D:\Projects\collidr`; adjust to where you cloned it.

**Claude Code**

```sh
claude mcp add collidr --scope user -e COLLIDR_PARTICIPANT=claude -- node D:\Projects\collidr\dist\cli.js serve
```

**Codex CLI** — `~/.codex/config.toml`

```toml
[mcp_servers.collidr]
command = "node"
args = ["D:\\Projects\\collidr\\dist\\cli.js", "serve"]
env = { COLLIDR_PARTICIPANT = "codex" }
tool_timeout_sec = 60
```

**Gemini CLI** — `~/.gemini/settings.json`

```json
{
  "mcpServers": {
    "collidr": {
      "command": "node",
      "args": ["D:\\Projects\\collidr\\dist\\cli.js", "serve"],
      "env": { "COLLIDR_PARTICIPANT": "gemini" }
    }
  }
}
```

Optional environment variables: `COLLIDR_MODEL`, `COLLIDR_ROLE`, `COLLIDR_DISPLAY_NAME`, `COLLIDR_CAPABILITIES` (comma-separated, e.g. `read_patch,run_tests`), `COLLIDR_WORKSPACE`, `COLLIDR_MAX_WAIT_S`.

**Workspaces.** Threads belong to a repository. Collidr uses, in order: the `workspace` argument an agent passes (a path inside the repo, or a workspace ID), then `COLLIDR_WORKSPACE`, then the git root of the directory the client launched the server in. If your client doesn't launch MCP servers inside your project, ask the agent to pass `workspace` with the repo path.

## Try a review

Start both agents in the same repository, then:

1. **Tell Codex:** "Use collidr: wait for review requests and handle them. Read the revision, comment, then post a verdict."
2. **Tell Claude:** "Use collidr to open a diff_review of my uncommitted changes with `codex` as reviewer, then wait for the verdict and address it."
3. Watch it happen in a third terminal: `collidr watch`.

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

## CLI

```
collidr serve                 stdio MCP server (what clients spawn)
collidr watch [--thread id]   live tail of events
collidr threads               list threads in the current repository
collidr show <thread_id>      state, requests, resolution and history
collidr doctor                check Node, SQLite, database and workspace
```

## Development

```sh
npm install
npm test          # builds, then runs unit, multi-process and MCP end-to-end tests
npm run typecheck
```
