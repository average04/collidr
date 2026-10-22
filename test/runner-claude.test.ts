import { realpathSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../src/runner/claude.js";
import { createConfig } from "../src/runner/config.js";
import type { AgentContext } from "../src/runner/types.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function context(mode = "success", overrides: Partial<AgentContext> = {}): AgentContext {
  const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), "collidr-claude-")));
  directories.push(workspace);
  return {
    agent: { id: "claude-managed", provider: "claude", command: process.execPath,
      args: [fixture, mode], instructions: "Follow the review protocol", allowedTools: ["Read", "mcp__collidr__post_message"], maxTurns: 5, model: "chosen-model" },
    workspace, database: join(workspace, "hub.db"), cliPath: join(workspace, "dist", "cli.js"),
    prompt: "Review literal $(echo nope), `text`, & and \"quoted\"\nNext line",
    sessionId: null, signal: new AbortController().signal, onSession() {}, ...overrides,
  };
}

describe("ClaudeAdapter", () => {
  it("passes generated workspace-scoped permissions without interpolating special path characters", async () => {
    const ctx = context();
    const workspace = join(ctx.workspace, "repo [literal], (team) ! # &");
    mkdirSync(workspace);
    const config = createConfig(workspace, ctx.cliPath, ctx.database);
    ctx.workspace = config.workspace;
    ctx.agent.allowedTools = config.agents.find(agent => agent.provider === "claude")!.allowedTools;
    const result = await new ClaudeAdapter().run(ctx);
    expect(result.status).toBe("completed");
    const observed = JSON.parse(result.output);
    expect(observed.cwd.toLowerCase()).toBe(config.workspace.toLowerCase());
    expect(observed.args[observed.args.indexOf("--allowedTools") + 1]).toBe("mcp__collidr__*,Read(/**)");
  });

  it("passes the prompt through stdin and isolates participant MCP identity, cwd, permissions and turn budget", async () => {
    const ctx = context();
    const sessions: string[] = [];
    ctx.onSession = (id) => sessions.push(id);
    const result = await new ClaudeAdapter().run(ctx);
    expect(result.status).toBe("completed");
    expect(result.sessionId).toBe("fixture-session");
    expect(sessions).toEqual(["fixture-session"]);
    const observed = JSON.parse(result.output);
    expect(observed.prompt).toBe(ctx.prompt);
    expect(observed.cwd).toBe(ctx.workspace);
    expect(observed.stateEvents).toBe("1");
    expect(observed.args).not.toContain(ctx.prompt);
    for (const [flag, value] of [["--output-format", "stream-json"], ["--permission-mode", "manual"], ["--permission-prompts", "none"], ["--max-turns", "5"], ["--model", "chosen-model"]]) {
      expect(observed.args[observed.args.indexOf(flag) + 1]).toBe(value);
    }
    expect(observed.args).toEqual(expect.arrayContaining(["-p", "--verbose", "--strict-mcp-config"]));
    expect(observed.args).not.toEqual(expect.arrayContaining(["--dangerously-skip-permissions"]));
    expect(observed.args[observed.args.indexOf("--allowedTools") + 1]).toBe("Read,mcp__collidr__post_message");
    const mcp = JSON.parse(observed.args[observed.args.indexOf("--mcp-config") + 1]);
    expect(mcp).toEqual({ mcpServers: { collidr: { type: "stdio", command: process.execPath,
      args: [ctx.cliPath, "serve"], env: { COLLIDR_PARTICIPANT: "claude-managed", COLLIDR_CLIENT: "claude", COLLIDR_MODEL: "chosen-model", COLLIDR_WORKSPACE: ctx.workspace, COLLIDR_DB: ctx.database } } } });
  });

  it("resumes only its saved session and retains the same identity", async () => {
    const result = await new ClaudeAdapter().run(context("success", { sessionId: "saved-session" }));
    expect(result.status).toBe("completed");
    expect(result.sessionId).toBe("saved-session");
    const args = JSON.parse(result.output).args as string[];
    expect(args[args.indexOf("--resume") + 1]).toBe("saved-session");
    expect(args).not.toContain("--continue");
    expect(args).not.toContain("--session-id");
  });

  it("does not leave provider descendants running after a successful turn", async () => {
    const result = await new ClaudeAdapter().run(context("success-descendant"));
    const descendantPid = Number(result.output);
    expect(descendantPid).toBeGreaterThan(0);
    try {
      expect(result.status).toBe("completed");
      expect(() => process.kill(descendantPid, 0)).toThrow();
    } finally { try { process.kill(descendantPid, "SIGKILL"); } catch { /* already reaped */ } }
  });

  it("preserves split UTF-8 and accepts a final NDJSON line without a newline", async () => {
    expect(await new ClaudeAdapter().run(context("chunked"))).toMatchObject({ status: "completed", output: "Complete 🦉" });
  });

  it.each(["denied", "requires-action", "result-denial", "max-turns", "error-success", "later-error", "deferred", "interrupted"])("blocks %s rather than reporting completion", async (mode) => {
    const result = await new ClaudeAdapter().run(context(mode));
    expect(result.status).toBe("blocked");
    expect(result.reason).toBeTruthy();
    expect(result.sessionId).toBe("fixture-session");
  });

  it.each(["nonzero", "eof", "malformed", "oversized", "wrong-session", "missing-result-text", "wrong-result-session"])("fails %s and does not accept an unverified successful run", async (mode) => {
    const result = await new ClaudeAdapter().run(context(mode, mode === "wrong-session" ? { sessionId: "saved-session" } : {}));
    expect(result.status).toBe("failed");
    expect(result.reason).toBeTruthy();
  });

  it("keeps bounded stderr diagnostics including the failure tail", async () => {
    const result = await new ClaudeAdapter().run(context("stderr"));
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("diagnostic-tail");
    expect(result.reason!.length).toBeLessThan(20_000);
  });

  it("persists initialization before completion and terminates a running child on cancellation", async () => {
    const controller = new AbortController();
    let pid: number | undefined;
    const sessions: string[] = [];
    const result = await new ClaudeAdapter().run(context("hang", { signal: controller.signal,
      onSpawn(value) { pid = value; }, onSession(id) { sessions.push(id); controller.abort(new Error("turn timeout")); } }));
    expect(result).toMatchObject({ status: "blocked", sessionId: "fixture-session" });
    expect(result.reason).toContain("turn timeout");
    expect(sessions).toEqual(["fixture-session"]);
    expect(pid).toBeDefined();
    expect(() => process.kill(pid!, 0)).toThrow();
  });

  it("does not spawn when already cancelled", async () => {
    let spawned = false;
    const signal = AbortSignal.abort(new Error("stopped"));
    const result = await new ClaudeAdapter().run(context("hang", { signal, onSpawn() { spawned = true; } }));
    expect(result.status).toBe("blocked");
    expect(spawned).toBe(false);
  });

  it("returns a diagnostic when the executable cannot start", async () => {
    const ctx = context();
    ctx.agent.command = join(ctx.workspace, "missing-agent.exe");
    const result = await new ClaudeAdapter().run(ctx);
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/ENOENT|not found|start/i);
  });
});
