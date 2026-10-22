# Developer installation implementation plan

**Goal:** A tested npm distribution and setup wizard for developers already using Claude Code and Codex.
**Architecture:** Reuse the runner config and launch paths; add provider launch discovery and a thin interactive/setup command. Verify an actual packed installation in a temporary prefix.
**Tech stack:** TypeScript, Node.js 22+, npm, Vitest, existing SQLite and MCP SDK.
**Spec:** `docs/superpowers/specs/2026-10-23-developer-install.md`

## Global Constraints

- Keep existing runner schema, dedicated identities, ownership and permission semantics.
- Never overwrite an existing setup configuration or modify global interactive client settings.
- Tests must use isolated temporary directories/databases and must not run real model turns or alter the live hub.
- Invoke providers without shell wrappers; npm JavaScript bins use Node plus an absolute script path.
- Use a stable installed Collidr CLI path; reject npm `_npx` cache paths when writing setup config.
- No registry publication in this implementation. Document unpublished availability accurately.

## Review Focus

Portable executable discovery, preservation of launch arguments, no accidental config replacement, packed runtime independence, meaningful setup and MCP smoke coverage.

## Task 1: Provider discovery and setup wizard

Files: add `src/runner/discovery.ts`, `src/setup.ts`, `test/provider-discovery.test.ts`, `test/setup.test.ts`; edit `src/runner/process.ts`, `src/runner/config.ts`, `src/cli.ts` and relevant existing tests only if needed.

1. Write failing tests for provider native discovery, Windows npm bin discovery (string/object bin; bad/missing bin; path containment), passing launch arguments into generated config, setup config creation, missing providers, preserving existing config, non-TTY guard, and cache rejection. Use real temp files and bounded fake executables at the process boundary; discovery may accept explicit platform/env/home for deterministic cross-platform tests.
2. Add `findProviderLaunch(provider)` returning `{command,args}`. Preserve `findProviderCommand` only if existing consumers need it. Follow native PATH, known Claude native location, Windows npm package roots next to PATH shims, and known Codex desktop fallback. Validate an advertised JS bin exists within its installed package. Do not shell out to npm or execute wrapper scripts.
3. Reuse this launch shape in `createConfig`. Add `collidr setup` help/routing. Interactive prompts select workspace/config/database and optional start. `--yes` accepts defaults, never implies starting; `--start` explicitly starts via runnerMain. Default config destination uses canonical workspace hash. Existing config causes an actionable refusal, not mutation or implicit start. Reject missing CLI providers before writing. Run Node version and isolated SQLite checks; report that authentication is not checked. Print commands and managed MCP explanation.
4. Run focused tests, typecheck/build, inspect the diff, commit task code. Report RED and GREEN command/output evidence. Do not run full suite concurrently with another heavy validation process.

## Task 2: Distributable package, smoke verification, CI, docs

Files: edit `package.json`, `package-lock.json`, `README.md`; add `scripts/package-smoke.mjs`, `.github/workflows/ci.yml`, `docs/releasing.md` as needed.

1. Add metadata and `prepack` build; preserve runtime-only dist package contents. Check package/version consistency in verification. Do not add an install-time TypeScript build requiring devDependencies.
2. Build a repeatable `npm run test:package` script that packs to an isolated temporary directory, installs globally into a temporary prefix, executes installed CLI help/doctor, invokes noninteractive setup with isolated fake providers, validates resulting absolute paths/arguments, and performs an MCP initialize/list-tools call against an isolated database. Use npm's JS CLI via Node where Windows wrappers would otherwise require shell execution. Assert LICENSE/README/runtime present and source/test/secret files absent from tarball. Cleanup only the verified temp root.
3. Demonstrate the smoke test fails with an intentionally missing artifact requirement before adding the packaging fix, then passes against the real packed installation. Keep network dependency installation failures distinct from product failures.
4. Add CI for Windows/macOS/Linux on Node 22 and 24 running npm ci, typecheck, tests, and artifact smoke. Prefer serialized test files in CI if needed for the pre-existing Windows process-probe timing sensitivity. Do not modify production process identity timing as an installation workaround.
5. Update README with clear prerequisites, setup behavior, current tarball install route, and registry install command marked as available after publication; document runner start/status/task commands and upgrades. Add a maintainer release checklist for version consistency, verification, npm login/publication and clean-machine validation. No publish workflow or secrets needed.
6. Run focused artifact smoke and then full verification serially; self-review and commit.

## Completion

Review each task's diff, resolve substantive findings, then one whole-branch review. Report exact test results, a retained local tarball path, branch/commits, and the remaining npm login/publication step. Preserve the worktree for review.
