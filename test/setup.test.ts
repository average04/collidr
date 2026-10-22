import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setupMain, defaultConfigPath, quoteArgument } from "../src/setup.js";
import { createConfig } from "../src/runner/config.js";

const roots: string[] = [];
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "collidr-setup-"))); roots.push(root);
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const cliPath = join(root, "cli.js"); writeFileSync(cliPath, "");
  const bin = join(root, "npm bin");
  for (const [pkg, name] of [["@anthropic-ai/claude-code", "claude"], ["@openai/codex", "codex"]]) {
    const dir = join(bin, "node_modules", pkg!); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ bin: { [name!]: "cli.js" } }));
    writeFileSync(join(dir, "cli.js"), 'if (process.argv[2] !== "--version") process.exit(5); console.log("fake 1.0");');
  }
  let output = "";
  const options = { cwd: workspace, home: root, cliPath, isTTY: false, discovery: { platform: "win32" as const, env: { PATH: bin, LOCALAPPDATA: root }, home: root }, output: (s: string) => { output += s; } };
  return { root, workspace, cliPath, options, output: () => output, config: join(root, "runner.json"), database: join(root, "production.db") };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const exec = promisify(execFile);
const installedCli = resolve("dist/cli.js");
describe("setup wizard", () => {
  it("routes installed CLI help and noninteractive validation", async () => {
    const help = await exec(process.execPath, [installedCli, "setup", "--help"], { windowsHide: true, timeout: 20000 });
    expect(help.stdout).toContain("--yes");
    await expect(exec(process.execPath, [installedCli, "setup"], { windowsHide: true, timeout: 20000 })).rejects.toThrow(/--yes/);
  });
  it("starts only on explicit --start with readiness acknowledgement", async () => {
    const f = fixture(); const bin = join(f.root, "npm bin");
    if (process.platform !== "win32") {
      for (const provider of ["claude", "codex"]) {
        const file = join(bin, provider); writeFileSync(file, `#!${process.execPath}\nif (process.argv[2] !== '--version') process.exit(9); console.log('fake');\n`); chmodSync(file, 0o755);
      }
    }
    const env = { ...process.env, PATH: bin, HOME: f.root, USERPROFILE: f.root, LOCALAPPDATA: f.root, COLLIDR_DB: f.database };
    try {
      const started = await exec(process.execPath, [installedCli, "setup", "--yes", "--start", "--workspace", f.workspace, "--config", f.config], { env, windowsHide: true, timeout: 20000 });
      expect(started.stdout).toMatch(/Runner started \(PID/);
      const status = await exec(process.execPath, [installedCli, "runner", "status", "--config", f.config], { env, windowsHide: true, timeout: 20000 });
      expect(JSON.parse(status.stdout).lease.pid).toBeGreaterThan(0);
    } finally {
      if (existsSync(f.config)) await exec(process.execPath, [installedCli, "runner", "stop", "--config", f.config], { env, windowsHide: true, timeout: 40000 });
    }
  }, 60000);
  it("writes launch arguments and dedicated identities without creating the production database", async () => {
    const f = fixture();
    expect(await setupMain(["--yes", "--config", f.config, "--database", f.database], f.options)).toBe(0);
    const config = JSON.parse(readFileSync(f.config, "utf8"));
    expect(config.agents.map((a: any) => a.id)).toEqual(["claude-managed", "codex-managed"]);
    expect(config.agents.every((a: any) => a.command === process.execPath && a.args[0].endsWith("cli.js"))).toBe(true);
    expect(existsSync(f.database)).toBe(false);
    expect(f.output()).toMatch(/authentication.*not checked/i);
    expect(f.output()).toContain("claude auth login"); expect(f.output()).toContain("codex login");
    expect(f.output()).toContain("runner start"); expect(f.output()).toContain("runner status"); expect(f.output()).toContain("runner task");
  });
  it("refuses a rerun before discovery or starting and preserves config bytes", async () => {
    const f = fixture(); writeFileSync(f.config, "preserve me");
    await expect(setupMain(["--yes", "--start", "--config", f.config], { ...f.options, discovery: { ...f.options.discovery, env: { PATH: "" } } })).rejects.toThrow(/already exists.*runner (start|status)/s);
    expect(readFileSync(f.config, "utf8")).toBe("preserve me"); expect(existsSync(f.database)).toBe(false);
  });
  it("fails missing providers with installation and login guidance before writing", async () => {
    const f = fixture();
    await expect(setupMain(["--yes", "--config", f.config], { ...f.options, discovery: { ...f.options.discovery, env: { PATH: "", LOCALAPPDATA: f.root } } })).rejects.toThrow(/claude.*install.*claude auth login/is);
    expect(existsSync(f.config)).toBe(false);
  });
  it("rejects failed version probes with actionable guidance and no config", async () => {
    const f = fixture();
    writeFileSync(join(f.root, "npm bin", "node_modules", "@openai", "codex", "cli.js"), 'process.stderr.write("broken install"); process.exit(7);');
    await expect(setupMain(["--yes", "--config", f.config], f.options)).rejects.toThrow(/codex --version failed.*broken install.*npm install.*codex login/s);
    expect(existsSync(f.config)).toBe(false);
  });
  it("requires --yes without a TTY", async () => { const f = fixture(); await expect(setupMain([], f.options)).rejects.toThrow(/--yes/); });
  it.each([{ args: ["extra"] }, { args: ["--unknown"] }, { args: ["--workspace"] }, { args: ["--yes", "--no-start"] }, { args: ["--yes", "--config", " "] }])("rejects invalid arguments $args", async ({ args }) => {
    const f = fixture(); await expect(setupMain(args, f.options)).rejects.toThrow();
  });
  it("shows all setup flags without requiring TTY or probing providers", async () => {
    const f = fixture(); expect(await setupMain(["--help"], f.options)).toBe(0);
    for (const flag of ["--yes", "--workspace", "--config", "--database", "--start"]) expect(f.output()).toContain(flag);
  });
  it("rejects persisting an npm npx cache CLI", async () => {
    const f = fixture(); const cliPath = join(f.root, "_npx", "123", "cli.js"); mkdirSync(join(f.root, "_npx", "123"), { recursive: true }); writeFileSync(cliPath, "");
    await expect(setupMain(["--yes", "--config", f.config], { ...f.options, cliPath })).rejects.toThrow(/_npx/);
    expect(existsSync(f.config)).toBe(false);
  });
  it("canonicalizes workspace aliases for per-workspace defaults", () => {
    const f = fixture(); const alias = join(f.root, "alias"); symlinkSync(f.workspace, alias, process.platform === "win32" ? "junction" : "dir");
    expect(defaultConfigPath(alias, f.root)).toBe(defaultConfigPath(f.workspace, f.root));
    expect(defaultConfigPath(f.workspace, f.root)).toMatch(/[\\/]\.collidr[\\/]runners[\\/][a-f0-9]+\.json$/);
    expect(defaultConfigPath(f.root, f.root)).not.toBe(defaultConfigPath(f.workspace, f.root));
  });
  it("quotes shell arguments for POSIX and PowerShell", () => {
    expect(quoteArgument("a'b $x", "linux")).toBe("'a'\"'\"'b $x'");
    expect(quoteArgument("a'b $x", "win32")).toBe("'a''b $x'");
  });
  it("preserves supplied provider launch arguments in createConfig", () => {
    const f = fixture(); const launches = { claude: { command: process.execPath, args: [f.cliPath, "extra"] }, codex: { command: process.execPath, args: [f.cliPath] } };
    expect(createConfig(f.workspace, f.cliPath, f.database, launches).agents[0]?.args).toEqual([f.cliPath, "extra"]);
  });
});
