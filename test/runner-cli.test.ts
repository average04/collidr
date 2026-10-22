import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RunnerState } from "../src/runner/state.js";

const exec = promisify(execFile);
const cli = resolve("dist/cli.js");
const configs: string[] = [];
const dirs: string[] = [];
const run = (...args: string[]) => exec(process.execPath, [cli, "runner", ...args], { timeout: 20000, windowsHide: true });
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "collidr-runner-cli-")); dirs.push(dir);
  const file = join(dir, "runner.json");
  await run("init", "--config", file, "--workspace", dir, "--database", join(dir, "hub.db"));
  configs.push(file);
  return { dir, file };
}
afterEach(async () => {
  for (const file of configs.splice(0)) {
    if (existsSync(file)) {
      const config = JSON.parse(readFileSync(file, "utf8"));
      config.cliPath = cli; writeFileSync(file, JSON.stringify(config));
    }
    try { await run("stop", "--config", file); } catch { /* failure tests may not have a live runner */ }
  }
  for (const dir of dirs.splice(0)) { if (!resolve(dir).startsWith(resolve(tmpdir()))) throw new Error("unsafe cleanup"); rmSync(dir, { recursive: true, force: true }); }
});

describe("runner CLI", () => {
  it("documents dedicated sessions in help", async () => {
    const result = await run("--help");
    expect(result.stdout).toMatch(/dedicated/i);
    expect(result.stdout).toContain("retry");
  });
  it("initializes safely and queues tasks durably without starting a model", async () => {
    const { file } = await setup();
    const config = JSON.parse(readFileSync(file, "utf8"));
    expect(config.agents.map((a: any) => a.id)).toEqual(["claude-managed", "codex-managed"]);
    await expect(run("init", "--config", file, "--workspace", config.workspace)).rejects.toThrow();
    await run("task", "--config", file, "--agent", "claude-managed", "--prompt", "Review a small plan.");
    const status = JSON.parse((await run("status", "--config", file)).stdout);
    expect(status.tasks).toHaveLength(1);
    expect(status.tasks[0].prompt).toBe("Review a small plan.");
    await expect(run("task", "--config", file, "--agent", "unknown", "--prompt", "No")).rejects.toThrow();
  });
  it("starts in background, rejects a second owner, and stops cleanly", async () => {
    const { file } = await setup();
    const started = await run("start", "--config", file, "--background");
    expect(started.stdout).toMatch(/started/i);
    const status = JSON.parse((await run("status", "--config", file)).stdout);
    expect(status.lease.pid).toBeGreaterThan(0);
    await expect(run("start", "--config", file, "--background")).rejects.toThrow();
    await run("stop", "--config", file);
    expect(JSON.parse((await run("status", "--config", file)).stdout).lease).toBeNull();
  });
  it("retries only the selected parked thread with a visible additional invocation allowance", async () => {
    const { file } = await setup();
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.maxTurnsPerThread = 1;
    writeFileSync(file, JSON.stringify(config));
    const state = new RunnerState(config.database);
    try {
      state.ensureAgent(config.workspace, "codex-managed");
      for (const threadId of ["first", "second"]) {
        state.addBudget(config.workspace, threadId);
        expect(state.beginRun(config.workspace, "codex-managed", { taskId: null, threadId, eventSeq: threadId === "first" ? 4 : 7 }, 1)).toBeNull();
      }
      state.advance(config.workspace, "codex-managed", 12);
    } finally { state.close(); }
    await run("retry", "--config", file, "--agent", "codex-managed");
    let status = JSON.parse((await run("status", "--config", file)).stdout);
    expect(status.deferredThreads.every((item: any) => item.blockedReason)).toBe(true);
    const retried = await run("retry", "--config", file, "--agent", "codex-managed", "--thread", "first");
    expect(retried.stdout).toMatch(/first.*1|1.*first/i);
    status = JSON.parse((await run("status", "--config", file)).stdout);
    expect(status.agents[0].cursor).toBe(12);
    expect(status.deferredThreads.find((item: any) => item.threadId === "first").blockedReason).toBeNull();
    expect(status.deferredThreads.find((item: any) => item.threadId === "second").blockedReason).toMatch(/budget/i);
    expect(status.budgets).toEqual([
      { threadId: "first", invocations: 1, additionalInvocations: 1 },
      { threadId: "second", invocations: 1, additionalInvocations: 0 },
    ]);
    await expect(run("retry", "--config", file, "--agent", "codex-managed", "--thread", "missing")).rejects.toThrow();
  });
  it("a failed provider pauses the task and does not automatically relaunch", async () => {
    const { dir, file } = await setup();
    const marker = join(dir, "calls.txt");
    const provider = join(dir, "fail.mjs");
    writeFileSync(provider, `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(marker)},'call\\n'); process.exit(7);`);
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.pollIntervalMs = 100;
    config.agents[0].command = process.execPath; config.agents[0].args = [provider];
    writeFileSync(file, JSON.stringify(config));
    await run("task", "--config", file, "--agent", "claude-managed", "--prompt", "Open a review.");
    await run("start", "--config", file, "--background");
    let blocked = false;
    for (let i = 0; i < 40; i++) {
      const status = JSON.parse((await run("status", "--config", file)).stdout);
      if (status.agents.find((a: any) => a.agentId === "claude-managed")?.blockedReason) { blocked = true; break; }
      await new Promise(r => setTimeout(r, 100));
    }
    expect(blocked).toBe(true);
    await new Promise(r => setTimeout(r, 400));
    expect(readFileSync(marker, "utf8")).toBe("call\n");
    await run("stop", "--config", file);
    await run("retry", "--config", file, "--agent", "claude-managed");
    expect(JSON.parse((await run("status", "--config", file)).stdout).tasks[0].status).toBe("queued");
  });
  it("can inspect and stop a running daemon after its configured CLI path disappears", async () => {
    const { dir, file } = await setup();
    await run("start", "--config", file, "--background");
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.cliPath = join(dir, "removed-cli.js");
    writeFileSync(file, JSON.stringify(config));
    expect(JSON.parse((await run("status", "--config", file)).stdout).lease).not.toBeNull();
    await run("stop", "--config", file);
    expect(JSON.parse((await run("status", "--config", file)).stdout).lease).toBeNull();
  });
});
