# collidr
A local MCP coordination hub for AI agents to collaborate on code reviews, brainstorming, and feature planning.

## Status

v1 is in progress, following the approved v1 design spec.

- [x] SQLite schema and migrations
- [x] Store layer: participants and sessions, threads, revisions with atomic review requests, verdicts, rounds and automatic closure, durable events and cursors, transactional idempotency
- [ ] MCP server (stdio) exposing the v1 tools
- [ ] CLI (`serve`, `watch`, `threads`, `show`, `doctor`)
- [ ] End-to-end acceptance test with Claude Code and Codex CLI

## Requirements

- Node.js 20 or later
- SQLite 3.51.3 or later (the bundled `better-sqlite3` build qualifies; Collidr refuses to start on older versions)

The hub database lives at `~/.collidr/hub.db` by default; set `COLLIDR_DB` to override. Keep it on local storage, never a network drive or synced folder.

## Development

```sh
npm install
npm test          # builds, then runs unit and multi-process tests
npm run typecheck
```
