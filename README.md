# collidr

A local MCP coordination hub for AI agents to collaborate on code reviews, brainstorming, and feature planning.

Claude Code, Codex CLI, Gemini CLI, Grok Build — any client that can run a local MCP server — each start their own `collidr serve` process. All of them share one SQLite database on your machine, so agents can open review threads, read the exact revision under review, leave anchored comments and verdicts, and wait for each other.

Collidr stores and delivers messages. You can run agents yourself, or use the optional runner to resume dedicated Claude and Codex sessions automatically when a review request or reply arrives.

## Status

v1 (manual participation, diff review and plan review) is implemented and passes the spec's acceptance suite, including an end-to-end Claude ↔ Codex exchange over real stdio MCP connections with restarts, retries and a changed diff.

Managed participation adds a local runner with durable delivery state, dedicated sessions, and bounded automatic handoffs. It uses your installed, authenticated Claude Code and Codex CLIs.

## Requirements

- Node.js 22 or later
- SQLite 3.51.3 or later — the bundled `better-sqlite3` build qualifies; Collidr refuses to start on older versions

The database lives at `~/.collidr/hub.db` (set `COLLIDR_DB` to change it). Keep it on local storage, never a network drive or a synced folder.

## Install and set up managed agents

Collidr is not yet published to npm. For now, obtain a tested `collidr-0.1.0.tgz` from the maintainer, or create one in a source checkout with `npm ci` followed by `npm run pack:release`. Packing compiles the runtime. `pack:release` explicitly enables the build hook because this repository disables dependency install scripts in `.npmrc`. Copy the tarball to the target machine; that machine does not need a source checkout or TypeScript.

```sh
npm install --global ./collidr-0.1.0.tgz
collidr doctor
cd /path/to/your/project
collidr setup
```

After registry publication, the installation command will be `npm install --global collidr`. This registry route is not available yet.

Install Claude Code and Codex separately and authenticate them first (`claude auth login` and `codex login`). Setup discovers the installed providers, probes that each launches with `--version`, checks Node and an isolated SQLite database, and writes a dedicated runner configuration. The launch probes do not verify provider version compatibility or authentication; setup does not run model turns. Follow the printed commands using the exact config path throughout:

```sh
collidr setup --yes --workspace /path/to/your/project --config /path/to/runner.json
collidr runner start --config /path/to/runner.json --background
collidr runner status --config /path/to/runner.json
collidr runner task --config /path/to/runner.json --agent claude-managed --prompt "Describe your task"
```

`--yes` accepts defaults and never starts the runner; starting requires `--start` or a separate start command. The default config is `~/.collidr/runners/<workspace-hash>.json`. Existing configurations are preserved: setup refuses to overwrite them and prints commands for using them. You can choose `--database FILE` and `--config FILE` explicitly.

Managed Claude and Codex sessions receive their Collidr MCP connection automatically, using dedicated `claude-managed` and `codex-managed` identities. No interactive client configuration changes are needed for this flow. Keep the installed package and Node executable at stable paths: the generated config records the installed CLI path. Setup rejects transient npm `_npx` cache paths.

To upgrade, stop the runner, install the replacement tarball, then restart using the same config (and stable global npm prefix):

```sh
collidr runner stop --config /path/to/runner.json
npm install --global ./collidr-0.1.0.tgz
collidr runner start --config /path/to/runner.json --background
collidr runner status --config /path/to/runner.json
```

## Connect your agents

This section is optional manual configuration for interactive clients. It does not require `collidr setup` or both provider CLIs; configure only the clients you use. Give every client its **own stable participant ID** with `COLLIDR_PARTICIPANT`. Two conversations that need separate inboxes must use different IDs.

For a global npm installation, run `npm root --global` and append `collidr/dist/cli.js` to the printed directory to obtain the stable CLI path. If you installed with a custom prefix, use `npm root --global --prefix /path/to/prefix`. You can also use `cliPath` from an existing runner config, or the absolute `dist/cli.js` path in a source checkout after `npm run build`.

In the examples, replace `/absolute/path/to/collidr/dist/cli.js` with that path; use the absolute Node executable as `command` if Node is not on the client PATH. Windows clients also launch Node plus the JavaScript file, avoiding npm shell shims.

**Claude Code**

```sh
claude mcp add collidr --scope user -e COLLIDR_PARTICIPANT=claude -- node /absolute/path/to/collidr/dist/cli.js serve
```

**Codex CLI** — `~/.codex/config.toml`

```toml
[mcp_servers.collidr]
command = "node"
args = ["/absolute/path/to/collidr/dist/cli.js", "serve"]
env = { COLLIDR_PARTICIPANT = "codex" }
tool_timeout_sec = 60
```

**Gemini CLI** — `~/.gemini/settings.json`

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

Optional environment variables: `COLLIDR_MODEL`, `COLLIDR_ROLE`, `COLLIDR_DISPLAY_NAME`, `COLLIDR_CAPABILITIES` (comma-separated, e.g. `read_patch,run_tests`), `COLLIDR_WORKSPACE`, `COLLIDR_MAX_WAIT_S`.

**Workspaces.** Threads belong to a repository. Collidr uses, in order: the `workspace` argument an agent passes (a path inside the repo, or a workspace ID), then `COLLIDR_WORKSPACE`, then the git root of the directory the client launched the server in. If your client doesn't launch MCP servers inside your project, ask the agent to pass `workspace` with the repo path.

## Try a manual review

Start both agents in the same repository, then:

1. **Tell Codex:** "Use collidr: wait for review requests and handle them. Read the revision, comment, then post a verdict."
2. **Tell Claude:** "Use collidr to open a diff_review of my uncommitted changes with `codex` as reviewer, then wait for the verdict and address it."
3. Watch it happen in a third terminal: `collidr watch`.

## Automatic handoffs

Submit one task and let the runner carry the conversation forward: Claude opens a review, Codex reviews it, Claude addresses feedback, and the agents repeat as needed until the author resolves the thread or a limit or error pauses the work. Normal handoffs need no human nudges.

The runner is a local Node.js process that polls the hub for actionable work every second by default. Polling itself makes no model calls. It starts or resumes an agent only when that agent has a queued task, review request, or actionable reply. When there is no work, the runner keeps watching without keeping an AI conversation going.

These are dedicated background sessions, separate from your visible Claude and Codex chats. The runner saves each provider's session ID and reuses it across turns and restarts.

### Start the runner

Run `collidr setup` once as shown above and use its printed config path. Pick one canonical workspace and hub database for both clients and the runner; two clones of the same repository have different workspace IDs. Configuration paths are resolved relative to the configuration file. If a runner is already configured, use its existing config path and skip setup. The remaining detailed examples use `node dist/cli.js` from a built source checkout; installed users can replace that prefix with `collidr` and use their actual config path. When upgrading, stop the existing runner first and restart it with the same configuration.

The generated configuration uses `claude-managed` and `codex-managed`. Automatic reviews must target the participant IDs in your runner configuration. With the default configuration, requests assigned to the interactive IDs `claude` or `codex` do not trigger automatic review turns. The `-managed` suffix is a naming convention; if you customize IDs, keep them distinct from your interactive clients so their inboxes and cursors stay separate.

### Run a live test

With both CLIs signed in and the runner running, check `runner status` for blocking reasons before submitting a task. Resume any paused test using the retry instructions below instead of queuing a replacement. Use the same config path throughout; the examples use `runner.json`.

```powershell
node dist/cli.js runner task --config "$HOME\.collidr\runner.json" --agent claude-managed --prompt "Read README.md and open a new plan_review proposing one documentation sentence. Ask codex-managed to review it and add codex as an observer. End your turn after opening the review. When resumed, address any feedback through a new revision, then resolve the thread after approval. Do not edit repository files, commit, push, or merge."
node dist/cli.js runner status --config "$HOME\.collidr\runner.json"
```

You can use `--prompt-file PATH` instead of `--prompt` for a longer task. The example uses the default managed IDs and the interactive `codex` observer; adjust those names to match your clients.

Watch the exchange from another terminal in the same checkout:

```powershell
node dist/cli.js watch
# Press Ctrl+C to stop watching, then inspect the new thread:
node dist/cli.js show THREAD_ID
```

`watch` and `show` use `COLLIDR_DB` or the default hub database, not the runner config. If your config selects a custom database, set `COLLIDR_DB` to that same path in the watching terminal.

Success means the current revision has the required approval, the author has resolved the thread, and both agents return idle with no blocking reason. A queued task marked `completed` only confirms its initial turn finished; check the thread's resolution to confirm the entire exchange. A straight approval usually takes three invocations (author → reviewer → author); requested changes add more turns automatically.

### Delivery and recovery

Once a task is submitted, the runner handles the author → reviewer → author exchange. It runs one agent at a time per workspace. It checkpoints delivery only after Collidr shows progress, wakes the author when required reviews finish or a reviewer requests changes, and skips closed threads and superseded requests. An intermediate approval or an undirected FYI comment does not start an unnecessary turn. It never consumes the agents' own acknowledgment cursors. A second supervisor for the same workspace and database is rejected.

The foreground command runs until Ctrl+C. `--background` uses a hidden process and appends lifecycle messages to `runner.log` beside the hub database. The runner must remain running, and both CLIs must already be signed in. It does not install a login service. The adapters target Claude Code 2.1.301's print-mode protocol and Codex 0.163.0-alpha.11's App Server protocol; incompatible older CLIs produce a blocked task with diagnostics. To operate it:

```powershell
node dist/cli.js runner status --config "$HOME\.collidr\runner.json"
node dist/cli.js runner retry --config "$HOME\.collidr\runner.json" --agent claude-managed
node dist/cli.js runner retry --config "$HOME\.collidr\runner.json" --agent claude-managed --thread THREAD_ID
node dist/cli.js runner stop --config "$HOME\.collidr\runner.json"
```

`status` reports session IDs, queued tasks, current work, and any blocking reason. Permission requests, provider errors (including usage or rate limits), timeouts, and turns that produce no Collidr progress pause that participant. A reviewer must complete its request or ask a question or raise an objection; partial comments alone do not count as a completed delivery. Inspect the reason, fix the problem, then use `retry`; retries are never automatic after an uncertain run. Stopping cancels the active provider process. Restarting preserves sessions and pending work. A crashed active delivery becomes blocked instead of being blindly repeated.

For a provider usage limit, wait until capacity returns, then run `runner retry --config FILE --agent AGENT_ID` for the blocked participant. The runner can still be running while one agent is blocked. It does not schedule a retry at the provider's reset time, and restarting the runner does not clear the block. An explicit retry resumes the saved work in the same session; there is no need to submit the task again.

An exhausted invocation budget parks only that thread's work, allowing unrelated threads to continue. `status` lists these deliveries under `deferredThreads`. `retry --agent ID --thread THREAD_ID` grants another `maxTurnsPerThread` allowance and resumes that agent's parked delivery. Lifetime invocation counts remain visible, and the global inbox checkpoint never moves backward. Ordinary `retry --agent ID` does not grant more thread budget.

### Permissions and configuration

The generated config explicitly allows both agents to use Collidr's coordination tools, so routine reads, review posts and resolutions do not need a human relay. Codex applies `allowedTools` to the twelve known Collidr tools using per-tool policy overrides; an exact `mcp__collidr__post` entry allows only that tool, while `mcp__collidr__*` allows the current coordination tool set. Other MCP servers and unknown future tools receive no grant. Claude receives `Read(/**)`, which scopes file reads and searches to its canonical workspace directory. Existing custom configurations retain their explicit grants; replace old generated bare `Read`, `Glob`, and `Grep` entries with `Read(/**)` to adopt the narrower default. Add narrowly scoped entries to Claude's `allowedTools` if you want it to edit files or run particular commands; otherwise such requests pause for your attention.

Codex reads its effective project configuration, preserves a read-only sandbox and restrictive approval policies, and caps broader filesystem access at `workspace-write`. If no sandbox is configured, the runner chooses read-only. Remaining approvals are routed to the user, and the runner pauses if the App Server requests one. Neither adapter bypasses permissions or authorizes a merge. Normal provider/project settings still apply; Claude uses only the explicitly configured MCP server, while Codex overrides its Collidr server in the child process. Global agent configuration files are not changed.

You can change provider `command`, `args`, optional `model`, role `instructions`, and limits in the JSON config. Native executables and `node` plus a JavaScript CLI are supported; Windows `.cmd`, `.bat`, and `.ps1` wrappers are rejected. Restart after changing configuration. Defaults are a one-second poll, five-minute invocation timeout, 20 Claude turns per invocation, and 12 provider invocations per Collidr thread. The latter count persists across restarts. Runner state lives in `<hub database>.runner.db`; keep it with the hub when backing up. Stop running supervisors before upgrading so sidecar migrations complete before they resume. The hub schema is unchanged. Use an isolated database when testing.

Provider protocol references: [Claude headless mode](https://code.claude.com/docs/en/headless), [Claude CLI options](https://code.claude.com/docs/en/cli-reference), and [Codex App Server](https://learn.chatgpt.com/docs/app-server).

On Windows, provider processes run inside a private Windows Job Object. The launcher uses built-in Windows PowerShell 5.1 and .NET to assign the provider before it starts, so descendants are cleaned up even if the provider exits first. This adds a short startup delay. Command arguments remain data; prompts are sent through stdin or JSON RPC. If process ownership cannot be established, the invocation fails instead of running untracked.

New leases and child records also save OS process birth identities. When an expired record's PID belongs to a different process, crash recovery can release the stale record without signaling the replacement process. An unavailable birth identity or a legacy record remains conservative: a potentially live process still prevents takeover.

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

## CLI

```
collidr serve                 stdio MCP server (what clients spawn)
collidr watch [--thread id]   live tail of events
collidr threads               list threads in the current repository
collidr show <thread_id>      state, requests, resolution and history
collidr doctor                check Node, SQLite, database and workspace
collidr setup                 configure dedicated managed Claude/Codex sessions
collidr runner --help         automatic handoff setup and operation
```

## Development

Use a current Node 22 or 24 release (Vitest requires Node 22.12+ on the 22.x line). Runtime consumers require Node 22+. CI covers Windows, macOS and Linux on both contributor Node versions.


```sh
npm ci
npm run build
npm test          # unit, multi-process and MCP end-to-end tests
npm run typecheck
```

See [release checklist](docs/releasing.md) for packaging and publication.
