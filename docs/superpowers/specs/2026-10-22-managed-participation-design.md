# Managed participation runner

The user wants Claude and Codex to continue review exchanges without a person relaying every turn. They explicitly chose dedicated background sessions instead of taking over interactive chats. Implement this as an optional local TypeScript CLI alongside Collidr, using the existing Node >=22 stack and existing authenticated CLIs.

## Behavior

- `collidr runner init --workspace PATH --config FILE` writes an explicit config for `claude-managed` and `codex-managed`. These identities are separate from interactive `claude`/`codex`. It does not rewrite global agent settings.
- `collidr runner start --config FILE` watches the configured workspace. `--background` starts the same supervisor hidden with a log file. `status`, `stop`, `retry --agent ID`, and `task --agent ID --prompt TEXT` provide operation and initial task submission.
- One managed session per participant persists across turns. Claude uses exact-ID print-mode resume; Codex uses JSONL App Server thread resume. Both receive per-process Collidr MCP settings pointing to the same absolute CLI, hub database and workspace.
- The supervisor discovers pending requests and replies from durable Collidr events, including reviewer verdicts that require the author to act. It uses independent persisted checkpoints, never an agent's acknowledgment cursor. Closed threads and stale requests do not wake a model.
- A successful exit alone does not prove work was handled. Event dispatches must show participant progress in Collidr, or become blocked. A locally queued task likewise must produce Collidr progress so handoffs cannot silently stop after an ordinary final answer.
- Prompts instruct reviewers to read exact revisions and post idempotent verdicts; authors respond to change requests, and explicitly resolve approved reviews rather than wait for the round limit. Agents end each turn; the supervisor waits for future events.
- A single workspace lease serializes runs, including across supervisor processes. State is stored in a sidecar SQLite file derived from the canonical hub database path. No hub schema migration is needed. A crashed/uncertain active run becomes blocked; it is never blindly replayed.
- Permission requests, malformed provider output, child failures, timeouts, and lack of Collidr progress block the affected participant. `retry` is an explicit user action. No bypass-permission flags or automatic approval responses.
- Defaults: poll every 1 second, 5-minute limit per provider invocation, at most 12 model invocations per Collidr thread. Claude also has a 20-turn provider limit. Limits persist where appropriate. Ctrl+C and `stop` cancel owned children and leave understandable status.
- Windows is a required platform: native executable discovery, no interpolated shell prompts, hidden child windows, bounded stdout/stderr, process cleanup. Support a native command or `node` plus a script argument. Do not silently execute .cmd/.ps1 through a shell.

## Scope

This adds orchestration, not new authority. Existing agent permissions remain boundaries; explicit allowed tools in the runner config may grant ordinary Collidr/read operations. Editing, shell execution, merges and external communications do not gain blanket approval. Commands submitted through `task` are human-authored work instructions; retrieved review content remains untrusted task material.

No UI, remote hosting, Windows login startup, or takeover of existing chats. The foreground/background process must be running to deliver automatic wakeups. The two agent CLIs must already be installed and authenticated. No new paid API account is required.

## Validation

Behavioral tests cover real SQLite state, concurrent leases, independent cursors, closed/stale work, no-progress blocking, retries, stop, budgets and crash recovery. Provider tests use real child processes implementing fixed NDJSON fixtures; they assert wire arguments, session reuse, permission handling, EOF/cancellation and terminal outcomes. Integration tests exercise author -> reviewer -> author resolution without human nudges. Finish with the full existing suite, typecheck, an independent code review, and a bounded live smoke test if both local CLI authentications permit it.
