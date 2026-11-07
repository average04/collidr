# Automatic handoffs (the runner)

Submit one task and let the runner carry the conversation forward: Claude opens a review, Codex reviews it, Claude addresses feedback, and the agents repeat as needed until the author resolves the thread or a limit or error pauses the work. Normal handoffs need no human nudges.

The runner is a local Node.js process that polls the hub for actionable work every second by default. Polling itself makes no model calls. It starts or resumes an agent only when that agent has a queued task, review request, or actionable reply. When there is no work, the runner keeps watching without keeping an AI conversation going.

These are dedicated background sessions, separate from your visible Claude and Codex chats. The runner saves each provider's session ID and reuses it across turns and restarts. It uses your installed, authenticated Claude Code and Codex CLIs.

Commands below use `collidr`. From a source checkout without a global install, use `node /path/to/collidr/dist/cli.js` instead.

## Install

Collidr is not yet published to npm. Install it one of two ways:

- **From source:** clone the repository, then run `npm ci`, `npm run build` and `npm install --global .` inside it. Keep the clone where it is; the global `collidr` command links to it.
- **From a tarball:** obtain a tested `collidr-0.1.0.tgz` from the maintainer, or create one in a source checkout with `npm ci` followed by `npm run pack:release`. Packing compiles the runtime. `pack:release` explicitly enables the build hook because this repository disables dependency install scripts in `.npmrc`. The target machine does not need a source checkout or TypeScript.

  ```sh
  npm install --global ./collidr-0.1.0.tgz
  ```

After registry publication, the installation command will be `npm install --global collidr`. This registry route is not available yet.

## Set up

Install Claude Code and Codex separately and authenticate them first (`claude auth login` and `codex login`). Then:

```sh
collidr doctor
cd /path/to/your/project
collidr setup
```

Setup discovers the installed providers, probes that each launches with `--version`, checks Node and an isolated SQLite database, and writes a dedicated runner configuration. The launch probes do not verify provider version compatibility or authentication; setup does not run model turns. Follow the printed commands using the exact config path throughout:

```sh
collidr setup --yes --workspace /path/to/your/project --config /path/to/runner.json
collidr runner start --config /path/to/runner.json --background
collidr runner status --config /path/to/runner.json
collidr runner task --config /path/to/runner.json --agent claude-managed --prompt "Describe your task"
```

`--yes` accepts defaults and never starts the runner; starting requires `--start` or a separate start command. The default config is `~/.collidr/runners/<workspace-hash>.json`. Existing configurations are preserved: setup refuses to overwrite them and prints commands for using them. You can choose `--database FILE` and `--config FILE` explicitly.

Pick one canonical workspace and hub database for both clients and the runner; two clones of the same repository have different workspace IDs. Configuration paths are resolved relative to the configuration file. If a runner is already configured, use its existing config path and skip setup.

Managed Claude and Codex sessions receive their Collidr MCP connection automatically, using dedicated `claude-managed` and `codex-managed` identities. No interactive client configuration changes are needed for this flow. Keep the installed package and Node executable at stable paths: the generated config records the installed CLI path. Setup rejects transient npm `_npx` cache paths.

Automatic reviews must target the participant IDs in your runner configuration. With the default configuration, requests assigned to the interactive IDs `claude` or `codex` do not trigger automatic review turns. The `-managed` suffix is a naming convention; if you customize IDs, keep them distinct from your interactive clients so their inboxes and cursors stay separate.

## Upgrade

Stop the runner, install the replacement, then restart using the same config (and stable global npm prefix):

```sh
collidr runner stop --config /path/to/runner.json
npm install --global ./collidr-0.1.0.tgz
collidr runner start --config /path/to/runner.json --background
collidr runner status --config /path/to/runner.json
```

## Run a live test

With both CLIs signed in and the runner running, check `runner status` for blocking reasons before submitting a task. Resume any paused test using the retry instructions below instead of queuing a replacement. Use the same config path throughout; the examples use `runner.json`.

```powershell
collidr runner task --config "$HOME\.collidr\runner.json" --agent claude-managed --prompt "Read README.md and open a new plan_review proposing one documentation sentence. Ask codex-managed to review it and add codex as an observer. End your turn after opening the review. When resumed, address any feedback through a new revision, then resolve the thread after approval. Do not edit repository files, commit, push, or merge."
collidr runner status --config "$HOME\.collidr\runner.json"
```

You can use `--prompt-file PATH` instead of `--prompt` for a longer task. The example uses the default managed IDs and the interactive `codex` observer; adjust those names to match your clients.

Watch the exchange from another terminal in the same checkout:

```powershell
collidr watch
# Press Ctrl+C to stop watching, then inspect the new thread:
collidr show THREAD_ID
```

`watch` and `show` use `COLLIDR_DB` or the default hub database, not the runner config. If your config selects a custom database, set `COLLIDR_DB` to that same path in the watching terminal.

Success means the current revision has the required approval, the author has resolved the thread, and both agents return idle with no blocking reason. A queued task marked `completed` only confirms its initial turn finished; check the thread's resolution to confirm the entire exchange. A straight approval usually takes three invocations (author → reviewer → author); requested changes add more turns automatically.

## Delivery and recovery

Once a task is submitted, the runner handles the author → reviewer → author exchange. It runs one agent at a time per workspace. It checkpoints delivery only after Collidr shows progress, wakes the author when required reviews finish or a reviewer requests changes, and skips closed threads and superseded requests. An intermediate approval or an undirected FYI comment does not start an unnecessary turn. It never consumes the agents' own acknowledgment cursors. A second supervisor for the same workspace and database is rejected.

The foreground command runs until Ctrl+C. `--background` uses a hidden process and appends lifecycle messages to `runner.log` beside the hub database. The runner must remain running, and both CLIs must already be signed in. It does not install a login service. The adapters target Claude Code 2.1.301's print-mode protocol and Codex 0.163.0-alpha.11's App Server protocol; incompatible older CLIs produce a blocked task with diagnostics. To operate it:

```powershell
collidr runner status --config "$HOME\.collidr\runner.json"
collidr runner retry --config "$HOME\.collidr\runner.json" --agent claude-managed
collidr runner retry --config "$HOME\.collidr\runner.json" --agent claude-managed --thread THREAD_ID
collidr runner stop --config "$HOME\.collidr\runner.json"
```

`status` reports session IDs, queued tasks, current work, and any blocking reason. Permission requests, provider errors (including usage or rate limits), timeouts, and turns that produce no Collidr progress pause that participant. A reviewer must complete its request or ask a question or raise an objection; partial comments alone do not count as a completed delivery. Inspect the reason, fix the problem, then use `retry`; retries are never automatic after an uncertain run. Stopping cancels the active provider process. Restarting preserves sessions and pending work. A crashed active delivery becomes blocked instead of being blindly repeated.

For a provider usage limit, wait until capacity returns, then run `runner retry --config FILE --agent AGENT_ID` for the blocked participant. The runner can still be running while one agent is blocked. It does not schedule a retry at the provider's reset time, and restarting the runner does not clear the block. An explicit retry resumes the saved work in the same session; there is no need to submit the task again.

An exhausted invocation budget parks only that thread's work, allowing unrelated threads to continue. `status` lists these deliveries under `deferredThreads`. `retry --agent ID --thread THREAD_ID` grants another `maxTurnsPerThread` allowance and resumes that agent's parked delivery. Lifetime invocation counts remain visible, and the global inbox checkpoint never moves backward. Ordinary `retry --agent ID` does not grant more thread budget.

## Permissions and configuration

The generated config explicitly allows both agents to use Collidr's coordination tools, so routine reads, review posts and resolutions do not need a human relay. Codex applies `allowedTools` to the twelve known Collidr tools using per-tool policy overrides; an exact `mcp__collidr__post` entry allows only that tool, while `mcp__collidr__*` allows the current coordination tool set. Other MCP servers and unknown future tools receive no grant. Claude receives `Read(/**)`, which scopes file reads and searches to its canonical workspace directory. Existing custom configurations retain their explicit grants; replace old generated bare `Read`, `Glob`, and `Grep` entries with `Read(/**)` to adopt the narrower default. Add narrowly scoped entries to Claude's `allowedTools` if you want it to edit files or run particular commands; otherwise such requests pause for your attention.

Codex reads its effective project configuration, preserves a read-only sandbox and restrictive approval policies, and caps broader filesystem access at `workspace-write`. If no sandbox is configured, the runner chooses read-only. Remaining approvals are routed to the user, and the runner pauses if the App Server requests one. Neither adapter bypasses permissions or authorizes a merge. Normal provider/project settings still apply; Claude uses only the explicitly configured MCP server, while Codex overrides its Collidr server in the child process. Global agent configuration files are not changed.

You can change provider `command`, `args`, optional `model`, role `instructions`, and limits in the JSON config. Native executables and `node` plus a JavaScript CLI are supported; Windows `.cmd`, `.bat`, and `.ps1` wrappers are rejected. Restart after changing configuration. Defaults are a one-second poll, five-minute invocation timeout, 20 Claude turns per invocation, and 12 provider invocations per Collidr thread. The latter count persists across restarts. Runner state lives in `<hub database>.runner.db`; keep it with the hub when backing up. Stop running supervisors before upgrading so sidecar migrations complete before they resume. The hub schema is unchanged. Use an isolated database when testing.

Provider protocol references: [Claude headless mode](https://code.claude.com/docs/en/headless), [Claude CLI options](https://code.claude.com/docs/en/cli-reference), and [Codex App Server](https://learn.chatgpt.com/docs/app-server).

## Process tracking on Windows

On Windows, provider processes run inside a private Windows Job Object. The launcher uses built-in Windows PowerShell 5.1 and .NET to assign the provider before it starts, so descendants are cleaned up even if the provider exits first. This adds a short startup delay. Command arguments remain data; prompts are sent through stdin or JSON RPC. If process ownership cannot be established, the invocation fails instead of running untracked.

New leases and child records also save OS process birth identities. When an expired record's PID belongs to a different process, crash recovery can release the stale record without signaling the replacement process. An unavailable birth identity or a legacy record remains conservative: a potentially live process still prevents takeover.
