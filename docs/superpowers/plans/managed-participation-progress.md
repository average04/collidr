# Managed participation validation

Initial implementation and independent review completed on 2026-10-22. The existing 43-test baseline was extended to 148 tests across 11 files. The full suite, TypeScript checks, build, and whitespace checks passed.

Regression coverage includes durable leases and crash recovery, ordered task delivery, session reuse, independent event cursors, stale requests, thread budgets, no-progress blocking, provider permissions and protocol races, CLI lifecycle, and Windows descendant-process cleanup. Provider tests use local child-process fixtures and do not call models.

A separate live smoke test used an isolated workspace and database. Claude opened a plan review, Codex approved it, and Claude resumed its saved session and resolved the thread. The complete exchange took exactly three provider invocations, with no retries or human nudges after the initial task. Both dedicated session IDs persisted, the review request completed, and the test supervisor stopped cleanly. No repository files were changed by the live agents.

The first live attempt exposed a missing Codex mapping for configured Collidr tool permissions. The adapter now grants only explicitly configured known Collidr tools through per-tool policy overrides, with four regression tests. Incoming permission requests still pause work. The successful live test used a fresh database and sessions after this fix.

Windows process ownership and supervisor-death cleanup were exercised on the development host. POSIX process-group cleanup is implemented but was not executed on that Windows host. The runner does not install login or reboot autostart.

Claude's r1 review identified budget starvation, unnecessary wakeups, incomplete reviewer delivery, broad read defaults, and PID reuse. The fixes park exhausted threads durably, expose a bounded per-thread retry, distinguish final approvals from intermediate approvals, ignore incidental comments, require a verdict or question/objection for outstanding review work, scope Claude reads to its workspace, and persist process birth identities. Sidecar migrations preserve queues, sessions, and lifetime invocation counts. Unknown legacy process identities remain conservative.

After those fixes, all 182 tests passed across 13 files, with typecheck, build, and whitespace checks also passing. New regressions were observed failing before implementation. Independent review found no further delivery issues. A separate offline probe of installed Claude Code 2.1.301 used a localhost fake API to exercise Read, Glob, and Grep: each succeeded inside a workspace containing spaces and punctuation, and each was denied outside it under `Read(/**)`. The earlier three-invocation live smoke predates these review fixes; the updated scheduler exchange is covered by the automated suite.
