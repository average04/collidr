import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, createConfig, writeConfig } from "../src/runner/config.js";

const dirs: string[] = [];
function setup() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "collidr-runner-config-"))); dirs.push(dir);
  mkdirSync(join(dir, "workspace")); writeFileSync(join(dir, "cli.js"), "");
  return { dir, file: join(dir, "config.json"), value: {
    version: 1, workspace: "workspace", database: "data/hub.db", cliPath: "cli.js",
    pollIntervalMs: 1000, turnTimeoutMs: 300000, maxTurnsPerThread: 12,
    agents: [{ id: "claude-managed", provider: "claude", command: process.execPath,
      args: [], instructions: "Review carefully", allowedTools: ["Read"], maxTurns: 20 }],
  } };
}
afterEach(() => { for (const dir of dirs.splice(0)) { if (!resolve(dir).startsWith(realpathSync.native(tmpdir()))) throw new Error("unsafe cleanup"); rmSync(dir, { recursive: true, force: true }); } });
describe("runner configuration", () => {
  it("resolves paths relative to the config, independent of cwd", () => {
    const { dir, file, value } = setup(); writeFileSync(file, JSON.stringify(value));
    const config = loadConfig(file);
    expect(config.workspace.toLowerCase()).toBe(join(dir, "workspace").toLowerCase());
    expect(config.database.toLowerCase()).toBe(join(dir, "data", "hub.db").toLowerCase());
    expect(config.cliPath).toBe(join(dir, "cli.js"));
  });
  it.each([
    ["duplicate participants", (v: any) => v.agents.push({ ...v.agents[0] })],
    ["unsupported version", (v: any) => v.version = 2],
    ["zero polling", (v: any) => v.pollIntervalMs = 0],
    ["empty tools", (v: any) => v.agents[0].allowedTools = []],
    ["shell wrappers", (v: any) => v.agents[0].command = "claude.cmd"],
    ["unbounded turns", (v: any) => v.maxTurnsPerThread = 0],
    ["unknown options", (v: any) => v.disablePermissions = true],
  ])("rejects %s", (_name, mutate) => {
    const { file, value } = setup(); mutate(value); writeFileSync(file, JSON.stringify(value));
    expect(() => loadConfig(file)).toThrow();
  });
  it("initializes dedicated identities and never overwrites a config", () => {
    const { dir, file } = setup();
    const config = createConfig(join(dir, "workspace"), join(dir, "cli.js"), join(dir, "hub.db"));
    expect(config.agents.map(a => a.id)).toEqual(["claude-managed", "codex-managed"]);
    writeConfig(file, config);
    expect(() => writeConfig(file, config)).toThrow();
    expect(loadConfig(file).agents.map(a => a.id)).toEqual(config.agents.map(a => a.id));
  });
  it("scopes generated read grants to the canonical workspace without granting Glob or Grep globally", () => {
    const { dir } = setup();
    const workspace = join(dir, "repo [literal], (team) ! # &");
    mkdirSync(join(workspace, ".git"), { recursive: true });
    const nested = join(workspace, "src"); mkdirSync(nested);
    const alias = join(dir, "alias"); symlinkSync(workspace, alias, process.platform === "win32" ? "junction" : "dir");
    const config = createConfig(join(alias, "src"), join(dir, "cli.js"), join(dir, "hub.db"));
    const canonical = realpathSync.native(workspace);
    expect(config.workspace).toBe(process.platform === "win32" ? canonical.toLowerCase() : canonical);
    for (const agent of config.agents) {
      expect(agent.allowedTools).toEqual(["mcp__collidr__*", "Read(/**)"]);
    }
  });
  it("preserves explicit tool grants when loading an existing config", () => {
    const { file, value } = setup();
    const allowedTools = ["Read", "Glob", "Grep", "Read(//other/location/**)", "Bash(git diff *)"];
    value.agents[0]!.allowedTools = allowedTools;
    writeFileSync(file, JSON.stringify(value));
    expect(loadConfig(file).agents[0]!.allowedTools).toEqual(allowedTools);
  });
  it("loads control coordinates when launch paths are unavailable", () => {
    const { file, value, dir } = setup();
    value.cliPath = "removed/cli.js"; value.workspace = "removed-workspace";
    writeFileSync(file, JSON.stringify(value));
    expect(() => loadConfig(file)).toThrow();
    expect(loadConfig(file, { launch: false }).workspace.toLowerCase()).toBe(join(dir, "removed-workspace").toLowerCase());
  });
});
