# Managed Participation Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Tasks use checkbox tracking.

**Goal:** Automatically run dedicated Claude/Codex sessions when Collidr work arrives.
**Architecture:** Optional local supervisor, sidecar durable state, provider adapters, existing Collidr event/store API. Workspace-wide serialization; fail closed on uncertainty.
**Tech Stack:** TypeScript, Node >=22, better-sqlite3, Vitest, native Claude CLI and Codex App Server.
**Spec:** ../specs/2026-10-22-managed-participation-design.md

## Global Constraints

- Existing hub schema and live configuration remain compatible; no hub migration.
- Dedicated managed participant IDs; exact persisted session IDs; one child turn per workspace.
- Never auto-accept permissions or use bypass flags. Prompts use stdin/JSON RPC, not shell interpolation.
- Windows native executable launch, bounded process output, cancellation and cleanup.
- Defaults: polling 1000ms, provider timeout 300000ms, 12 invocations/thread, Claude maxTurns 20.
- No model calls in automated tests. Use actual child-process protocol fixtures and real SQLite.

## Review Focus

Concurrent supervisors; in-flight crash/uncertain completion; event batches spanning threads; foreign workspace or stale request delivery; provider approval/EOF/notification races.

## Tasks

1. [x] Shared contracts, configuration, native child lifecycle. Write failing configuration/process tests, implement, verify. Root owns `types.ts`, `config.ts`, `process.ts` and corresponding tests.
2. [x] Durable state and scheduler. Implementer owns `state.ts`, `scheduler.ts`, `prompt.ts`, state/scheduler tests. Contracts in task-core.md. Tests first: locks, stale crash blocking, ordered cursors, no-progress, limits, task queue, author/reviewer handoff and stop.
3. [x] Codex adapter. Implementer owns `codex.ts`, protocol fixture and adapter tests. Contracts in task-codex.md. Tests first for initialization/resume, terminal race, approval blocking, EOF and cancellation.
4. [x] Claude adapter. Implementer owns `claude.ts`, protocol fixture and adapter tests. Contracts in task-claude.md. Tests first for exact resume, MCP isolation, denial/result semantics and malformed/missing result.
5. [x] CLI integration and documentation. Root owns runner command wiring, examples and CLI tests. Verify init/status/task/start/stop/retry and background lifecycle using test providers, then real bounded agent smoke.
6. [x] Independent review, fix findings with covering tests, full suite/typecheck/build. Record exact live-test outcome and any remaining limitations. Keep the isolated feature worktree available for review.
