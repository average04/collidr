# Developer installation

Make Collidr installable as an npm CLI for developers with Node.js 22+ and authenticated Claude Code and Codex tools. The intended released flow is `npm install -g collidr`, then `collidr setup` inside a project. The initial release must also work when installed from a local npm tarball before publication.

The setup wizard asks for a workspace and configuration destination, discovers both providers, verifies Node and SQLite using an isolated temporary database, and writes a runner configuration using the existing schema and dedicated participant IDs. The default config lives under `~/.collidr/runners/<workspace-hash>.json`, so projects do not overwrite each other. The default hub database remains `~/.collidr/hub.db` (respecting COLLIDR_DB). An optional explicit start choice launches the existing background runner. Managed child sessions already receive their MCP connection automatically. Setup does not modify global interactive Claude/Codex settings or authenticate the providers; it explains those limits and prints actionable login/start/status/task commands.

Provide `--yes`, `--workspace`, `--config`, `--database`, and `--start` for scripted use. Without a TTY require `--yes`. Do not overwrite an existing configuration; give its path and the existing runner commands. Reject a missing provider with useful installation/login guidance. Reject persisting a Collidr CLI path inside an npm `_npx` cache, since it may disappear.

Discovery supports native executables on Windows/macOS/Linux and npm-installed provider JavaScript bins on Windows. Read the provider package's advertised `bin` entry instead of parsing shell shims or guessing native package internals. Invoke JS bins as the current Node executable plus an absolute script argument. Continue rejecting shell wrappers and preserve all runner ownership/permission semantics.

The npm artifact builds at pack time, contains its compiled runtime, license, and README, and is independently installable without the repository or devDependencies. A repeatable package smoke test packs, installs in a temporary prefix, executes the installed CLI and setup with isolated fake providers, and verifies an MCP handshake against an isolated database. CI covers the supported OS families. Document prerequisites, the pre-publication tarball route, the eventual registry route, setup, and upgrades.

No public publication, global configuration writes, provider model calls, or changes to the running production hub are part of implementation/testing.
