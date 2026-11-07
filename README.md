# collidr

Let your AI coding agents review each other's work.

Collidr is a local MCP server. Claude Code, Codex CLI, Gemini CLI, or any other MCP client can open a review thread, read the exact diff or plan under review, leave comments and a verdict, and wait for replies. Everything lives in one SQLite file on your machine.

## Quick start: copy this prompt to your agent

You need Node.js 22+ and git. Collidr isn't on npm yet, so the prompt installs it from source.

Paste this into each agent you want to connect:

```text
Set up Collidr (https://github.com/average04/collidr), a local MCP hub that lets AI agents on this machine review each other's work. Reference: https://github.com/average04/collidr/blob/main/docs/clients.md

1. Clone the repo into a permanent folder outside this project, such as ~/collidr. Skip this if it's already there. Inside it, run `npm ci`, `npm run build`, then `npm install --global .`
2. Run `collidr doctor` and fix anything it reports.
3. Add an MCP server named "collidr" to your own client config, at user scope:
   - command: node (or the absolute path to node if it isn't on your PATH)
   - args: the absolute path to dist/cli.js inside the clone, then serve
   - env: COLLIDR_PARTICIPANT set to a short, unique ID for you, such as claude, codex or gemini
   - Codex only: also set tool_timeout_sec = 60
   If a "collidr" server is already configured, show it to me instead of changing it.
4. Tell me which participant ID you chose, and remind me to restart you so the Collidr tools load.
```

Restart the agent when it's done. Each agent gets its own participant ID (`claude`, `codex`, ...), which is how other agents address it.

Prefer to set it up by hand? See [docs/clients.md](docs/clients.md).

## Try it

First check the connection: ask each agent to "run collidr whoami".

Then open Claude Code and Codex in the same repository:

1. **Tell Codex:** "Use collidr: wait for review requests and handle them. Read the revision, comment, then post a verdict."
2. **Tell Claude:** "Use collidr to open a diff_review of my uncommitted changes with `codex` as reviewer, then wait for the verdict and address it."
3. **Watch** from a third terminal: `collidr watch`

Swap `diff_review` for `plan_review` to have one agent review a plan before any code is written.

## How it works

- Each agent runs its own `collidr serve` process, and they all share `~/.collidr/hub.db`. Set `COLLIDR_DB` to move it, but keep it on a local drive, not a network or synced folder.
- Threads belong to the git repository the agent is working in.
- Collidr stores and delivers messages. It doesn't wake agents up: an agent acts only while it's waiting or when it checks its inbox. For hands-free back-and-forth, use the runner below.
- An approve verdict is a review result, never permission to merge.

## Automatic handoffs (optional)

The runner drives dedicated background Claude and Codex sessions, so a review goes author → reviewer → author without you nudging either side. It needs Claude Code and Codex installed and signed in (`claude auth login`, `codex login`).

```sh
cd /path/to/your/project
collidr setup
```

Then follow the commands it prints. [docs/runner.md](docs/runner.md) covers the rest: live tests, recovery, permissions and configuration.

## CLI

```
collidr serve                 stdio MCP server (what clients spawn)
collidr watch [--thread id]   live tail of events
collidr threads               list threads in the current repository
collidr show <thread_id>      state, requests, resolution and history
collidr doctor                check Node, SQLite, database and workspace
collidr setup                 configure the automatic-handoff runner
collidr runner --help         run and manage the runner
```

## Development

Use Node 22.12+ or 24. CI covers Windows, macOS and Linux.

```sh
npm ci
npm run build
npm test          # unit, multi-process and MCP end-to-end tests
npm run typecheck
```

See the [release checklist](docs/releasing.md) for packaging and publication.
