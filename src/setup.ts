import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { defaultDatabasePath, openDatabase } from "./db.js";
import { canonicalPath, createConfig, writeConfig } from "./runner/config.js";
import { findProviderLaunch, type DiscoveryOptions, type ProviderLaunch } from "./runner/discovery.js";
import { runnerMain } from "./runner/cli.js";
import type { Provider } from "./runner/types.js";
import { findGitRoot } from "./workspace.js";

const HELP = `collidr setup — configure dedicated managed Claude/Codex sessions

  collidr setup [--yes] [--workspace PATH] [--config FILE] [--database FILE] [--start]

--yes        Accept defaults without prompts (does not start the runner)
--workspace  Project directory (default current project)
--config     New config file (default ~/.collidr/runners/<workspace-hash>.json)
--database   Hub database (default COLLIDR_DB or ~/.collidr/hub.db)
--start      Explicitly start the background runner after setup
--help, -h   Show this help

Requires Node.js 22+, Claude Code and Codex installed and authenticated.
Setup checks --version only; authentication is not checked.
Authenticate separately: claude auth login / codex login
`;
export interface SetupOptions {
  cwd?: string; home?: string; cliPath?: string; isTTY?: boolean;
  discovery?: DiscoveryOptions; output?: (text: string) => void;
}
export function defaultConfigPath(workspace: string, home = homedir()): string {
  const root = canonicalPath(findGitRoot(resolve(workspace)) ?? workspace);
  return join(home, ".collidr", "runners", `${createHash("sha256").update(root).digest("hex").slice(0, 24)}.json`);
}
/** Printed Windows commands target PowerShell; POSIX commands target sh/bash. */
export function quoteArgument(value: string, platform: NodeJS.Platform = process.platform): string {
  return `'${value.replace(/'/g, platform === "win32" ? "''" : `'"'"'`)}'`;
}
function commands(file: string): string {
  const config = `--config ${quoteArgument(file)}`;
  return `collidr runner start ${config} --background\ncollidr runner status ${config}\ncollidr runner task ${config} --agent claude-managed --prompt ${quoteArgument("Describe your task")}\n`;
}
function refuseExisting(file: string): void {
  let present = false;
  try { lstatSync(file); present = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (present) throw new Error(`Configuration already exists: ${file}. It has not been changed.\n${commands(file)}`);
}
function guidance(provider: Provider): string {
  return provider === "claude"
    ? "Install Claude Code (https://code.claude.com/docs/en/setup), then run claude auth login."
    : "Install Codex (npm install -g @openai/codex), then run codex login.";
}
function checkProvider(provider: Provider, options?: DiscoveryOptions): ProviderLaunch {
  const launch = findProviderLaunch(provider, options);
  if (!launch) throw new Error(`Missing ${provider} provider. ${guidance(provider)}`);
  const result = spawnSync(launch.command, [...launch.args, "--version"], {
    shell: false, windowsHide: true, timeout: 15000, encoding: "utf8", maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) throw new Error(`${provider} --version failed: ${result.error?.message ?? (result.stderr?.trim() || `exit code ${result.status}`)}. ${guidance(provider)}`);
  return launch;
}
function selfTest(): void {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Setup requires Node.js 22 or newer.");
  const root = mkdtempSync(join(tmpdir(), "collidr-setup-check-"));
  try {
    const db = openDatabase(join(root, "self-test.db"));
    try { db.prepare("SELECT 1").get(); } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
export async function setupMain(argv: string[], options: SetupOptions = {}): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    yes: { type: "boolean" }, workspace: { type: "string" }, config: { type: "string" }, database: { type: "string" },
    start: { type: "boolean" }, help: { type: "boolean", short: "h" },
  } });
  const output = options.output ?? ((text: string) => { process.stdout.write(text); });
  if (positionals.length) throw new Error(`Unexpected setup arguments: ${positionals.join(" ")}`);
  for (const name of ["workspace", "config", "database"] as const) if (values[name] !== undefined && !values[name]!.trim()) throw new Error(`--${name} must not be empty`);
  if (values.help) { output(HELP); return 0; }
  if (!values.yes && !(options.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY))) throw new Error("Non-interactive setup requires --yes. Use collidr setup --help.");
  let workspace = resolve(options.cwd ?? process.cwd(), values.workspace ?? ".");
  let configFile: string;
  let database = values.database ?? defaultDatabasePath();
  let start = Boolean(values.start);
  if (!values.yes) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!values.workspace) workspace = resolve((await input.question(`Workspace [${workspace}]: `)).trim() || workspace);
      const defaultFile = defaultConfigPath(workspace, options.home);
      configFile = resolve(values.config ?? ((await input.question(`Configuration [${defaultFile}]: `)).trim() || defaultFile));
      refuseExisting(configFile);
      if (!values.database) database = (await input.question(`Database [${database}]: `)).trim() || database;
      if (!values.start) {
        const answer = (await input.question("Start background runner now? [y/N]: ")).trim();
        if (answer && !/^(y|yes|n|no)$/i.test(answer)) throw new Error("Start choice must be yes or no.");
        start = /^(y|yes)$/i.test(answer);
      }
    } finally { input.close(); }
  } else configFile = resolve(values.config ?? defaultConfigPath(workspace, options.home));
  refuseExisting(configFile);
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) throw new Error(`Workspace is not a directory: ${workspace}`);
  const cliPath = resolve(options.cliPath ?? fileURLToPath(new URL("./cli.js", import.meta.url)));
  if (!existsSync(cliPath) || !statSync(cliPath).isFile()) throw new Error(`Installed Collidr CLI missing: ${cliPath}; build or reinstall Collidr.`);
  if ([cliPath, realpathSync.native(cliPath)].some(path => path.split(/[\\/]/).some(part => part.toLowerCase() === "_npx"))) {
    throw new Error("Cannot persist a Collidr CLI in an npm _npx cache. Install Collidr globally from a package or tarball, then rerun setup.");
  }
  selfTest();
  const launches = { claude: checkProvider("claude", options.discovery), codex: checkProvider("codex", options.discovery) };
  const config = createConfig(workspace, cliPath, resolve(database), launches);
  writeConfig(configFile, config);
  output(`Created ${configFile}\nNode and isolated SQLite checks passed. Provider --version checks passed; authentication is not checked.\nAuthenticate separately: claude auth login / codex login\nDedicated participants: claude-managed, codex-managed. Managed sessions receive Collidr MCP automatically.\nInteractive client settings are unchanged.\n${process.platform === "win32" ? "PowerShell commands:\n" : "Commands:\n"}${commands(configFile)}`);
  if (start) return runnerMain(["start", "--config", configFile, "--background"]);
  return 0;
}
