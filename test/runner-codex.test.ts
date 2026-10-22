import { realpathSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/runner/codex.js";
import type { AgentContext } from "../src/runner/types.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const directories: string[] = [];
const controllers: AbortController[] = [];

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(scenario = "complete") {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "collidr-codex-test-")));
  directories.push(directory);
  const capture = join(directory, "wire.jsonl");
  const controller = new AbortController();
  controllers.push(controller);
  const sessions: string[] = [];
  const context: AgentContext = {
    agent: { id: "codex-managed", provider: "codex", command: process.execPath,
      args: [fixture, scenario, capture], instructions: "Follow the Collidr protocol.", allowedTools: [], maxTurns: 20 },
    workspace: directory, database: join(directory, "hub.db"), cliPath: join(directory, "cli.js"),
    prompt: "Review the exact revision.", sessionId: null, signal: controller.signal,
    onSession(id) { sessions.push(id); writeFileSync(capture + ".session", id); },
  };
  return { context, capture, controller, sessions, wire: () => readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line)) };
}

async function waitForFile(path: string) {
  const deadline = Date.now() + 5000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error("Child fixture did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Codex managed adapter", () => {
  it("initializes, saves a new session before work, and reports a completed turn", async () => {
    const s = setup();
    s.context.agent.model = "selected-model";
    const result = await new CodexAdapter().run(s.context);
    expect(result).toMatchObject({ status: "completed", sessionId: "managed-thread", output: "Review posted." });
    expect(s.sessions).toEqual(["managed-thread"]);
    const wire = s.wire();
    expect(wire[0].cwd).toBe(s.context.workspace);
    expect(wire[0].args).toContain("app-server");
    expect(wire[0].args).toContain("stdio://");
    expect(wire[0].args).toContain('mcp_servers.collidr.env.COLLIDR_PARTICIPANT="codex-managed"');
    expect(wire[0].args).toContain(`mcp_servers.collidr.env.COLLIDR_DB=${JSON.stringify(s.context.database)}`);
    expect(wire[0].args).toContain(`mcp_servers.collidr.env.COLLIDR_WORKSPACE=${JSON.stringify(s.context.workspace)}`);
    expect(wire[0].args).toContain(`mcp_servers.collidr.args=${JSON.stringify([s.context.cliPath, "serve"])}`);
    expect(wire[0].args).toContain("mcp_servers.collidr.required=true");
    expect(wire[1]).toMatchObject({ method: "initialize", params: { clientInfo: { name: "collidr_runner" } } });
    expect(wire[2].method).toBe("initialized");
    expect(wire[3]).toMatchObject({ method: "config/read", params: { includeLayers: false, cwd: s.context.workspace } });
    expect(wire[4]).toMatchObject({ method: "thread/start", params: {
      model: "selected-model", cwd: s.context.workspace, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write",
      developerInstructions: "Follow the Collidr protocol.",
    } });
    expect(wire[5]).toMatchObject({ method: "turn/start", params: {
      threadId: "managed-thread", input: [{ type: "text", text: "Review the exact revision.", text_elements: [] }],
    } });
  });

  it.each([false, true])("preserves read-only/untrusted permissions when resuming is %s", async (resume) => {
    const s = setup("readonly-config");
    if (resume) s.context.sessionId = "saved-restricted-session";
    expect(await new CodexAdapter().run(s.context)).toMatchObject({ status: "completed" });
    const request = s.wire().find((entry) => entry.method === (resume ? "thread/resume" : "thread/start"));
    expect(request.params).toMatchObject({ sandbox: "read-only", approvalPolicy: "untrusted", approvalsReviewer: "user" });
  });

  it("caps full-access configuration at workspace writes with user approvals", async () => {
    const s = setup("fullaccess-config");
    expect(await new CodexAdapter().run(s.context)).toMatchObject({ status: "completed" });
    expect(s.wire().find((entry) => entry.method === "thread/start").params).toMatchObject({
      sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "user",
    });
  });

  it.each(["unset-config", "null-config"])("defaults %s to read-only instead of adding write authority", async (scenario) => {
    const s = setup(scenario);
    expect(await new CodexAdapter().run(s.context)).toMatchObject({ status: "completed" });
    expect(s.wire().find((entry) => entry.method === "thread/start").params).toMatchObject({ sandbox: "read-only", approvalPolicy: "on-request" });
  });

  it("preserves granular approval restrictions", async () => {
    const s = setup("granular-config");
    expect(await new CodexAdapter().run(s.context)).toMatchObject({ status: "completed" });
    expect(s.wire().find((entry) => entry.method === "thread/start").params.approvalPolicy).toEqual({ granular: {
      sandbox_approval: false, rules: true, skill_approval: false, request_permissions: true, mcp_elicitations: false,
    } });
  });

  it.each(["unknown-sandbox", "unknown-policy", "invalid-granular", "missing-config", "config-error"])("does not start a thread for unsupported %s", async (scenario) => {
    const s = setup(scenario);
    expect(await new CodexAdapter().run(s.context)).toMatchObject({ status: "failed" });
    expect(s.wire().some((entry) => ["thread/start", "thread/resume", "turn/start"].includes(entry.method))).toBe(false);
    expect(s.sessions).toEqual([]);
  });

  it("resumes only the saved session and retains the configured default model", async () => {
    const s = setup();
    s.context.sessionId = "exact-persisted-session";
    expect(await new CodexAdapter().run(s.context)).toMatchObject({ status: "completed", sessionId: "exact-persisted-session" });
    const request = s.wire().find((entry) => entry.method === "thread/resume");
    expect(request.params.threadId).toBe("exact-persisted-session");
    expect(request.params.excludeTurns).toBe(true);
    expect(request.params).not.toHaveProperty("model");
    expect(s.wire().some((entry) => entry.method === "thread/start")).toBe(false);
  });

  it("matches early completion to the acknowledged turn instead of stale events", async () => {
    const s = setup("early-completion");
    expect(await new CodexAdapter().run(s.context)).toMatchObject({ status: "completed", sessionId: "managed-thread", output: "Current answer" });
  });

  it.each(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput", "mcpServer/elicitation/request"])("blocks on %s without granting it", async (method) => {
    const s = setup(`approval:${method}`);
    const result = await new CodexAdapter().run(s.context);
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain(method);
    expect(s.wire().some((entry) => entry.method === "turn/interrupt")).toBe(true);
    expect(s.wire().some((entry) => entry.result !== undefined)).toBe(false);
  });

  it("includes bounded MCP request diagnostics without URLs, credentials or raw request fields", async () => {
    const s = setup("elicitation-diagnostics");
    const result = await new CodexAdapter().run(s.context);
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("collidr");
    expect(result.reason).toContain("Approve the Collidr review lookup.");
    expect(result.reason!.length).toBeLessThan(1600);
    for (const sensitive of ["https://", "url-secret", "bearer-secret", "key-secret", "hidden-schema-secret", "hidden-token-secret"]) {
      expect(result.reason).not.toContain(sensitive);
    }
    expect(s.wire().some((entry) => entry.result !== undefined)).toBe(false);
  });

  it.each([
    { allowed: ["mcp__collidr__read_thread", "mcp__collidr__post", "mcp__collidr__future_tool", "mcp__other__*", "Read"], expected: ["read_thread", "post"] },
    { allowed: ["mcp__collidr__*"], expected: ["register", "whoami", "list_threads", "open_thread", "submit_revision", "read_revision", "post", "read_thread", "inbox", "wait_for_messages", "ack", "resolve"] },
    { allowed: ["mcp__collidr__read_*", "mcp__other__*"], expected: [] },
  ])("applies the runner allowlist only to known Collidr tools: $allowed", async ({ allowed, expected }) => {
    const s = setup();
    s.context.agent.allowedTools = allowed;
    expect(await new CodexAdapter().run(s.context)).toMatchObject({ status: "completed" });
    const args = s.wire()[0].args as string[];
    const approvalOverrides = args.filter((arg) => arg.includes("approval_mode"));
    expect(approvalOverrides.sort()).toEqual(expected.map((name) => `mcp_servers.collidr.tools.${name}.approval_mode="approve"`).sort());
    expect(args.some((arg) => arg.includes("disabled_tools") || arg.includes("default_tools_approval_mode"))).toBe(false);
  });

  it.each([
    ["eof", "provider exited before completion"], ["rpc-error", "Not authenticated"],
    ["malformed", "JSON"], ["oversize", "limit"], ["output-limit", "limit"],
    ["failed", "Provider rejected the turn"], ["invalid-status", "status"],
  ])("fails safely for %s", async (scenario, expected) => {
    const s = setup(scenario);
    const result = await new CodexAdapter().run(s.context);
    expect(result.status).toBe("failed");
    expect(result.reason?.toLowerCase()).toContain(expected.toLowerCase());
  });

  it("interrupts a cancelled running turn and reaps the child", async () => {
    const s = setup("hang");
    let pid: number | undefined;
    s.context.onSpawn = (value) => { pid = value; };
    const pending = new CodexAdapter().run(s.context);
    await waitForFile(s.capture + ".ready");
    s.controller.abort(new Error("Turn deadline exceeded"));
    expect(await pending).toMatchObject({ status: "blocked", reason: expect.stringContaining("deadline") });
    expect(s.wire().some((entry) => entry.method === "turn/interrupt")).toBe(true);
    expect(pid).toBeDefined();
    expect(() => process.kill(pid!, 0)).toThrow();
  });

  it("does not start a child after cancellation", async () => {
    const s = setup();
    s.controller.abort();
    expect(await new CodexAdapter().run(s.context)).toMatchObject({ status: "blocked" });
    expect(existsSync(s.capture)).toBe(false);
  });

  it("does not start a model turn if session persistence fails", async () => {
    const s = setup();
    s.context.onSession = () => { throw new Error("State is not writable"); };
    expect(await new CodexAdapter().run(s.context)).toMatchObject({ status: "failed", reason: expect.stringContaining("State is not writable") });
    expect(s.wire().some((entry) => entry.method === "turn/start")).toBe(false);
  });

  it("returns a failed result for a missing executable", async () => {
    const s = setup();
    s.context.agent.command = join(s.context.workspace, "missing-provider.exe");
    expect(await new CodexAdapter().run(s.context)).toMatchObject({ status: "failed", reason: expect.stringMatching(/ENOENT|not found/i) });
  });

  it("returns a failed outcome if an existing file cannot launch as a native process", async () => {
    const s = setup();
    s.context.agent.command = fixture;
    expect(await new CodexAdapter().run(s.context)).toMatchObject({ status: "failed", reason: expect.any(String) });
  });
});
