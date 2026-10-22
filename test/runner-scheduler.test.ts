import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunnerState } from "../src/runner/state.js";
import { RunnerScheduler } from "../src/runner/scheduler.js";
import type { AgentAdapter, AgentContext, RunnerConfig } from "../src/runner/types.js";
import { PATCH_R1, key, makeHub, type Hub } from "./helpers.js";

let hub: Hub;
let state: RunnerState;
let config: RunnerConfig;
beforeEach(() => {
  hub = makeHub();
  state = new RunnerState(hub.file);
  config = {
    version: 1, workspace: "/repo/collidr", database: hub.file, cliPath: "/collidr/dist/cli.js",
    pollIntervalMs: 1000, turnTimeoutMs: 1000, maxTurnsPerThread: 12,
    agents: [
      { id: hub.claude.participantId, provider: "claude", command: "claude", args: [], instructions: "", allowedTools: [], maxTurns: 20 },
      { id: hub.codex.participantId, provider: "codex", command: "codex", args: [], instructions: "", allowedTools: [], maxTurns: 20 },
    ],
  };
});
afterEach(() => { state.close(); hub.close(); });
function review() {
  return hub.store.openThread(hub.claude, {
    idempotencyKey: key(), workspaceId: hub.workspaceId, type: "diff_review", title: "Fix sum",
    reviewers: [hub.codex.participantId], contentType: "patch", content: PATCH_R1,
  });
}
function scheduler(run: (context: AgentContext) => ReturnType<AgentAdapter["run"]>) {
  return new RunnerScheduler(config, hub.store, state, { claude: { run }, codex: { run } });
}
function comment(actor: "claude" | "codex", threadId: string) {
  hub.store.post(hub[actor], { idempotencyKey: key(), threadId, kind: "comment", body: "Reviewed the current request." });
}

describe("managed participation scheduling", () => {
  it("automatically completes task -> author request -> reviewer approval -> author resolution in three invocations", async () => {
    let opened: ReturnType<typeof review>;
    const seen: string[] = [];
    const runner = scheduler(async (context) => {
      seen.push(context.agent.id);
      context.onSession(`${context.agent.id}-session`);
      if (seen.length === 1) {
        expect(context.prompt).toContain("Fix sum and ask the managed reviewer");
        opened = review();
      } else if (seen.length === 2) {
        expect(context.prompt).toContain(opened.request_ids[0]);
        hub.store.post(hub.codex, { idempotencyKey: key(), threadId: opened.thread_id, kind: "verdict", verdict: "approve", body: "Approved", responseRequestId: opened.request_ids[0] });
      } else {
        expect(context.sessionId).toBe(`${hub.claude.participantId}-session`);
        hub.store.resolve(hub.claude, { idempotencyKey: key(), threadId: opened.thread_id, expectedRevisionId: opened.revision_id, outcome: "resolved", summary: "Approved and resolved." });
      }
      return { status: "completed", output: "Handled in Collidr" };
    });
    state.enqueue(config.workspace, hub.claude.participantId, "Fix sum and ask the managed reviewer");
    expect(await runner.tick()).toBe(true);
    expect(await runner.tick()).toBe(true);
    expect(await runner.tick()).toBe(true);
    expect(await runner.tick()).toBe(false);
    expect(seen).toEqual([hub.claude.participantId, hub.codex.participantId, hub.claude.participantId]);
    expect(hub.store.getThread(opened!.thread_id).status).toBe("resolved");
    expect(state.getBudget(config.workspace, opened!.thread_id)).toBe(3);
  });

  it("preserves work on a second interleaved thread and ignores the participant acknowledgement cursor", async () => {
    const first = review();
    const second = review();
    hub.store.ack(hub.codex.participantId, "inbox", hub.store.maxSeq());
    const handled: string[] = [];
    const runner = scheduler(async (context) => {
      expect(context.agent.id).toBe(hub.codex.participantId);
      const target = handled.length === 0 ? first : second;
      expect(context.prompt).toContain(target.thread_id);
      handled.push(target.thread_id);
      hub.store.post(hub.codex, { idempotencyKey: key(), threadId: target.thread_id, kind: "verdict", verdict: "approve", body: "Approved", responseRequestId: target.request_ids[0] });
      return { status: "completed", output: "Posted" };
    });
    // Isolate reviewer delivery; author followups are exercised by the full exchange above.
    config.agents = [config.agents[1]!];
    expect(await runner.tick()).toBe(true);
    expect(await runner.tick()).toBe(true);
    expect(handled).toEqual([first.thread_id, second.thread_id]);
  });

  it("leaves events arriving during the invocation pending", async () => {
    config.agents = [config.agents[1]!];
    const opened = review();
    let calls = 0;
    const runner = scheduler(async () => {
      calls++;
      comment("codex", opened.thread_id);
      if (calls === 1) comment("claude", opened.thread_id);
      return { status: "completed", output: "Posted" };
    });
    expect(await runner.tick()).toBe(true);
    expect(await runner.tick()).toBe(true);
    expect(await runner.tick()).toBe(false);
    expect(calls).toBe(2);
  });

  it("skips closed and superseded requests, then invokes only for the current revision", async () => {
    config.agents = [config.agents[1]!];
    const closed = review();
    hub.store.resolve(hub.claude, { idempotencyKey: key(), threadId: closed.thread_id, expectedRevisionId: closed.revision_id, outcome: "unresolved", summary: "Cancelled" });
    const opened = review();
    const newer = hub.store.submitRevision(hub.claude, { idempotencyKey: key(), threadId: opened.thread_id, contentType: "patch", content: PATCH_R1 + "\n// updated" });
    let calls = 0;
    const runner = scheduler(async (context) => {
      calls++;
      expect(context.prompt).toContain(newer.request_ids[0]);
      expect(context.prompt).not.toContain(opened.request_ids[0]);
      comment("codex", opened.thread_id);
      return { status: "completed", output: "Done" };
    });
    expect(await runner.tick()).toBe(true);
    expect(await runner.tick()).toBe(false);
    expect(calls).toBe(1);
  });

  it("blocks a successful provider that makes no target progress, retaining work until explicit retry", async () => {
    config.agents = [config.agents[1]!];
    const opened = review();
    let progress = false;
    const runner = scheduler(async (context) => {
      context.onSession("resume-me");
      if (progress) comment("codex", opened.thread_id);
      return { status: "completed", output: "Only a final answer" };
    });
    expect(await runner.tick()).toBe(true);
    const blocked = state.getAgent(config.workspace, hub.codex.participantId);
    expect(blocked.blockedReason).toMatch(/progress/i);
    const requestSeq = hub.store.listVisibleEvents(hub.codex.participantId).events.find((event) => event.type === "request_created")!.seq;
    expect(blocked.cursor).toBeLessThan(requestSeq);
    expect(await runner.tick()).toBe(false);
    progress = true;
    state.retry(config.workspace, hub.codex.participantId);
    expect(await runner.tick()).toBe(true);
    expect(state.getAgent(config.workspace, hub.codex.participantId).blockedReason).toBeNull();
  });

  it("does not count progress by another actor or in another workspace as delivery", async () => {
    config.agents = [config.agents[1]!];
    const opened = review();
    const otherWorkspace = hub.store.ensureWorkspace("/other");
    const runner = scheduler(async () => {
      comment("claude", opened.thread_id);
      hub.store.openThread(hub.codex, { idempotencyKey: key(), workspaceId: otherWorkspace.id, type: "plan_review", title: "Other", reviewers: [hub.claude.participantId], contentType: "plan", content: "Unrelated" });
      return { status: "completed", output: "Done" };
    });
    await runner.tick();
    expect(state.getAgent(config.workspace, hub.codex.participantId).blockedReason).toMatch(/progress/i);
  });

  it("does not satisfy a delivery with the same actor's progress on a different thread", async () => {
    config.agents = [config.agents[1]!];
    review();
    const unrelated = review();
    const runner = scheduler(async () => {
      comment("codex", unrelated.thread_id);
      return { status: "completed", output: "Posted elsewhere" };
    });
    await runner.tick();
    expect(state.getAgent(config.workspace, hub.codex.participantId).blockedReason).toMatch(/progress/i);
  });

  it("retains silent queued tasks as blocked and preserves failed sessions across restart", async () => {
    const runner = scheduler(async (context) => {
      context.onSession("session-before-failure");
      return { status: "failed", output: "Could not continue", reason: "Permission required" };
    });
    const id = state.enqueue(config.workspace, hub.claude.participantId, "Start a review");
    await runner.tick();
    const restarted = scheduler(async () => { throw new Error("Must not automatically retry"); });
    expect(await restarted.tick()).toBe(false);
    expect(state.status(config.workspace).tasks).toEqual([expect.objectContaining({ id, status: "blocked" })]);
    expect(state.getAgent(config.workspace, hub.claude.participantId)).toMatchObject({ sessionId: "session-before-failure", blockedReason: "Permission required" });
  });

  it("blocks a silent successful queued task instead of dropping the initial handoff", async () => {
    const runner = scheduler(async () => ({ status: "completed", output: "Looks good" }));
    const id = state.enqueue(config.workspace, hub.claude.participantId, "Start a review");
    await runner.tick();
    expect(state.status(config.workspace).tasks).toEqual([expect.objectContaining({ id, status: "blocked" })]);
    expect(state.getAgent(config.workspace, hub.claude.participantId).blockedReason).toMatch(/progress/i);
  });

  it.each(["timeout", "abort"])("bounds an adapter turn on %s and never retries it automatically", async (cause) => {
    config.turnTimeoutMs = 20;
    const controller = new AbortController();
    const runner = scheduler(async (context) => new Promise((resolve) => {
      context.signal.addEventListener("abort", () => resolve({ status: "failed", reason: "Cancelled", output: "" }), { once: true });
      if (cause === "abort") controller.abort();
    }));
    state.enqueue(config.workspace, hub.claude.participantId, "Start");
    expect(await runner.tick(controller.signal)).toBe(true);
    expect(state.getAgent(config.workspace, hub.claude.participantId).blockedReason).toMatch(/timed out|abort|cancel/i);
    expect(await runner.tick()).toBe(false);
  });

  it.each(["immediate", "delayed"])("preserves %s cancelled adapter cleanup before allowing the supervisor to stop", async (mode) => {
    config.turnTimeoutMs = 10;
    let cleaned = false;
    const runner = scheduler(async (context) => new Promise((resolve) => {
      context.signal.addEventListener("abort", () => {
        const cleanup = () => { cleaned = true; resolve({ status: "failed" as const, output: "Partial output", reason: "Cancelled" }); };
        if (mode === "immediate") cleanup();
        else setTimeout(cleanup, 30);
      }, { once: true });
    }));
    state.enqueue(config.workspace, hub.claude.participantId, "Start");
    await runner.tick();
    expect(cleaned).toBe(true);
    expect(state.getAgent(config.workspace, hub.claude.participantId)).toMatchObject({ output: "Partial output", active: null, blockedReason: expect.stringMatching(/timed out/) });
  });

  it("counts a queued task's thread invocation even if its provider fails after creating the thread", async () => {
    let threadId = "";
    const runner = scheduler(async () => {
      threadId = review().thread_id;
      return { status: "failed", output: "Interrupted", reason: "Permission required" };
    });
    state.enqueue(config.workspace, hub.claude.participantId, "Start");
    await runner.tick();
    expect(state.getBudget(config.workspace, threadId)).toBe(1);
    expect(state.getAgent(config.workspace, hub.claude.participantId).blockedReason).toBe("Permission required");
  });

  it("enforces a persisted thread budget without relaunching on later events", async () => {
    config.agents = [config.agents[1]!];
    config.maxTurnsPerThread = 1;
    const opened = review();
    const runner = scheduler(async () => {
      comment("codex", opened.thread_id);
      return { status: "completed", output: "Done" };
    });
    expect(await runner.tick()).toBe(true);
    comment("claude", opened.thread_id);
    const restarted = scheduler(async () => { throw new Error("Budget must prevent this call"); });
    expect(await restarted.tick()).toBe(false);
    expect(state.getAgent(config.workspace, hub.codex.participantId).blockedReason).toMatch(/budget|limit/i);
  });

  it("continues past a page of lifecycle events on later ticks", async () => {
    config.agents = [config.agents[1]!];
    for (let i = 0; i < 75; i++) {
      const closed = review();
      hub.store.resolve(hub.claude, { idempotencyKey: key(), threadId: closed.thread_id, expectedRevisionId: closed.revision_id, outcome: "unresolved", summary: "Closed" });
    }
    const opened = review();
    const runner = scheduler(async (context) => {
      expect(context.prompt).toContain(opened.thread_id);
      comment("codex", opened.thread_id);
      return { status: "completed", output: "Done" };
    });
    expect(await runner.tick()).toBe(false);
    expect(await runner.tick()).toBe(true);
  });
});
