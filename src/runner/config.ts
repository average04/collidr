import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { defaultDatabasePath } from "../db.js";
import { findGitRoot } from "../workspace.js";
import { findProviderCommand, validateCommand } from "./process.js";
import type { RunnerConfig } from "./types.js";

const agentSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/),
  provider: z.enum(["claude", "codex"]), command: z.string().min(1),
  args: z.array(z.string()), model: z.string().min(1).optional(),
  instructions: z.string().max(32000), allowedTools: z.array(z.string().min(1)).min(1),
  maxTurns: z.number().int().min(1).max(100),
}).strict();
const configSchema = z.object({
  version: z.literal(1), workspace: z.string().min(1), database: z.string().min(1), cliPath: z.string().min(1),
  pollIntervalMs: z.number().int().min(100).max(60000),
  turnTimeoutMs: z.number().int().min(1000).max(3600000),
  maxTurnsPerThread: z.number().int().min(1).max(100),
  agents: z.array(agentSchema).min(1).max(16),
}).strict();

/** Resolve symlinks even when a database file or its parent does not exist yet. */
export function canonicalPath(file: string): string {
  const absolute = resolve(file);
  let ancestor = absolute;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`No existing parent for ${file}`);
    ancestor = parent;
  }
  const result = resolve(realpathSync.native(ancestor), relative(ancestor, absolute));
  return process.platform === "win32" ? result.toLowerCase() : result;
}

export function loadConfig(file: string, options: { launch?: boolean } = {}): RunnerConfig {
  const absolute = resolve(file);
  const config = configSchema.parse(JSON.parse(readFileSync(absolute, "utf8")));
  const pathFromConfig = (p: string) => resolve(dirname(absolute), p);
  const workspace = pathFromConfig(config.workspace);
  if (options.launch !== false && (!existsSync(workspace) || !statSync(workspace).isDirectory())) throw new Error(`Workspace is not a directory: ${workspace}`);
  config.workspace = canonicalPath(findGitRoot(workspace) ?? workspace);
  config.database = canonicalPath(pathFromConfig(config.database));
  config.cliPath = pathFromConfig(config.cliPath);
  if (options.launch !== false && (!existsSync(config.cliPath) || !statSync(config.cliPath).isFile())) throw new Error(`Build Collidr first; CLI missing: ${config.cliPath}`);
  if (new Set(config.agents.map(a => a.id)).size !== config.agents.length) throw new Error("Agent participant IDs must be unique");
  for (const agent of config.agents) {
    if (options.launch !== false) validateCommand(agent.command);
    if (!isAbsolute(agent.command) && /[\\/]/.test(agent.command)) agent.command = pathFromConfig(agent.command);
  }
  return config;
}

export function createConfig(workspace: string, cliPath: string, database = defaultDatabasePath()): RunnerConfig {
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) throw new Error(`Workspace is not a directory: ${workspace}`);
  const config: RunnerConfig = {
    version: 1, workspace: canonicalPath(findGitRoot(workspace) ?? workspace), database: canonicalPath(database), cliPath: resolve(cliPath),
    pollIntervalMs: 1000, turnTimeoutMs: 300000, maxTurnsPerThread: 12,
    agents: ["claude", "codex"].map(provider => ({
      id: `${provider}-managed`, provider: provider as "claude" | "codex", command: findProviderCommand(provider as "claude" | "codex"), args: [],
      instructions: provider === "claude"
        ? "Implement the assigned task, then request a review from codex-managed using Collidr. Address feedback and submit a new revision. Resolve the thread when approved."
        : "Review the assigned Collidr revision carefully, inspect relevant files, and post a verdict responding to the current request. Give concrete findings with evidence.",
      allowedTools: ["mcp__collidr__*", "Read", "Glob", "Grep"], maxTurns: 20,
    })),
  };
  return configSchema.parse(config);
}

export function writeConfig(file: string, config: RunnerConfig): void {
  mkdirSync(dirname(resolve(file)), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

export function runnerLogPath(config: RunnerConfig): string {
  return join(dirname(config.database), "runner.log");
}
