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
function question(threadId: string) {
  return hub.store.post(hub.codex, { idempotencyKey: key(), threadId, kind: "question", body: "Should negative values be supported?" });
}
function approve(opened: ReturnType<typeof review>, actor = hub.codex, requestId = opened.request_ids[0]) {
  hub.store.post(actor, { idempotencyKey: key(), threadId: opened.thread_id, kind: "verdict", verdict: "approve", body: "Approved", responseRequestId: requestId });
}

describe("managed participation scheduling", () => {
  it("waits for all required approvals and wakes the author once for the final approval", async () => {
    config.agents = [config.agents[0]!];
    const opened = hub.store.openThread(hub.claude, {
      idempotencyKey: key(), workspaceId: hub.workspaceId, type: "diff_review", title: "Two reviewers",
      reviewers: [hub.codex.participantId, hub.gemini.participantId], contentType: "patch", content: PATCH_R1,
    });
    let calls = 0;
    const runner = scheduler(async () => {
      calls++;
      hub.store.resolve(hub.claude, { idempotencyKey: key(), threadId: opened.thread_id, expectedRevisionId: opened.revision_id, outcome: "resolved", summary: "Both approved" });
      return { status: "completed", output: "Resolved" };
    });
    const requests = hub.store.listRequests(opened.thread_id);
    approve(opened, hub.codex, requests.find(r => r.assignee_id === hub.codex.participantId)!.id);
    expect(await runner.tick()).toBe(false);
    expect(state.getAgent(config.workspace, hub.claude.participantId).blockedReason).toBeNull();
    approve(opened, hub.gemini, requests.find(r => r.assignee_id === hub.gemini.participantId)!.id);
    expect(await runner.tick()).toBe(true);
    expect(await runner.tick()).toBe(false);
    expect(calls).toBe(1);
  });

  it("delivers request_changes immediately even while another required review remains open", async () => {
    config.agents = [config.agents[0]!];
    const opened = hub.store.openThread(hub.claude, {
      idempotencyKey: key(), workspaceId: hub.workspaceId, type: "diff_review", title: "Two reviewers",
      reviewers: [hub.codex.participantId, hub.gemini.participantId], contentType: "patch", content: PATCH_R1,
    });
    const request = hub.store.listRequests(opened.thread_id).find(r => r.assignee_id === hub.codex.participantId)!;
    hub.store.post(hub.codex, { idempotencyKey: key(), threadId: opened.thread_id, kind: "verdict", verdict: "request_changes", body: "Add coverage", responseRequestId: request.id });
    const runner = scheduler(async () => {
      hub.store.submitRevision(hub.claude, { idempotencyKey: key(), threadId: opened.thread_id, contentType: "patch", content: PATCH_R1 + "\n// coverage added" });
      return { status: "completed", output: "Revised" };
    });
    expect(await runner.tick()).toBe(true);
    expect(await runner.tick()).toBe(false);
  });

  it("does not wake a completed reviewer for FYI comments but delivers directed comments and questions", async () => {
    config.agents = [config.agents[1]!];
    const opened = review();
    approve(opened);
    comment("claude", opened.thread_id);
    let calls = 0;
    const runner = scheduler(async () => { calls++; comment("codex", opened.thread_id); return { status: "completed", output: "Answered" }; });
    expect(await runner.tick()).toBe(false);
    hub.store.post(hub.claude, { idempotencyKey: key(), threadId: opened.thread_id, kind: "comment", body: "Please confirm the release note", recipients: [hub.codex.participantId] });
    expect(await runner.tick()).toBe(true);
    hub.store.post(hub.claude, { idempotencyKey: key(), threadId: opened.thread_id, kind: "question", body: "One more detail?" });
    expect(await runner.tick()).toBe(true);
    expect(await runner.tick()).toBe(false);
    expect(calls).toBe(2);
  });

  it("blocks partial review notes until the assigned request is completed or a meaningful question is posted", async () => {
    config.agents = [config.agents[1]!];
    const opened = review();
    let finish = false;
    const runner = scheduler(async () => {
      if (finish) approve(opened); else comment("codex", opened.thread_id);
      return { status: "completed", output: "Posted" };
    });
    expect(await runner.tick()).toBe(true);
    expect(state.getAgent(config.workspace, hub.codex.participantId).blockedReason).toMatch(/request|review/i);
    expect(hub.store.getRequest(opened.request_ids[0]!).status).toBe("open");
    expect(await runner.tick()).toBe(false);
    finish = true;
    state.retry(config.workspace, hub.codex.participantId);
    expect(await runner.tick()).toBe(true);
    expect(hub.store.getRequest(opened.request_ids[0]!).status).toBe("completed");
    expect(state.getAgent(config.workspace, hub.codex.participantId).blockedReason).toBeNull();
  });

  it.each(["contextual", "reply_to"])("preserves an author's %s answer to an outstanding review question", async (kind) => {
    config.agents = [config.agents[1]!];
    const opened = review();
    let calls = 0;
    let questionId = "";
    const runner = scheduler(async () => {
      if (++calls === 1) questionId = question(opened.thread_id).message_id;
      else approve(opened);
      return { status: "completed", output: "Posted" };
    });
    expect(await runner.tick()).toBe(true);
    hub.store.post(hub.claude, { idempotencyKey: key(), threadId: opened.thread_id, kind: "comment", body: "Yes, negatives are supported.", ...(kind === "reply_to" ? { replyTo: questionId } : {}) });
    expect(await runner.tick()).toBe(true);
    expect(await runner.tick()).toBe(false);
    expect(hub.store.getRequest(opened.request_ids[0]!).status).toBe("completed");
  });

  it("requires author progress after the final verdict even though no review requests remain open", async () => {
    config.agents = [config.agents[0]!];
    const opened = review();
    approve(opened);
    const runner = scheduler(async () => ({ status: "completed", output: "All reviews done" }));
    expect(await runner.tick()).toBe(true);
    expect(state.getAgent(config.workspace, hub.claude.participantId).blockedReason).toMatch(/progress/i);
    expect(hub.store.getThread(opened.thread_id).status).toBe("open");
  });

  it("coalesces already-completed required reviews without jumping over an interleaved thread", async () => {
    config.agents = [config.agents[0]!];
    const first = hub.store.openThread(hub.claude, {
      idempotencyKey: key(), workspaceId: hub.workspaceId, type: "diff_review", title: "Two reviewers",
      reviewers: [hub.codex.participantId, hub.gemini.participantId], contentType: "patch", content: PATCH_R1,
    });
    const second = review();
    const requests = hub.store.listRequests(first.thread_id);
    approve(first, hub.codex, requests.find(r => r.assignee_id === hub.codex.participantId)!.id);
    approve(second);
    approve(first, hub.gemini, requests.find(r => r.assignee_id === hub.gemini.participantId)!.id);
    const handled: string[] = [];
    const runner = scheduler(async context => {
      const target = context.prompt.includes(second.thread_id) ? second : first;
      handled.push(target.thread_id);
      hub.store.resolve(hub.claude, { idempotencyKey: key(), threadId: target.thread_id, expectedRevisionId: target.revision_id, outcome: "resolved", summary: "Approved" });
      return { status: "completed", output: "Resolved" };
    });
    expect(await runner.tick()).toBe(true);
    expect(await runner.tick()).toBe(true);
    expect(await runner.tick()).toBe(false);
    expect(handled).toEqual([second.thread_id, first.thread_id]);
  });

  it("uses one canonical author wakeup when a verdict and request completion straddle event pages", async () => {
    config.agents = [config.agents[0]!];
    const opened = review();
    // Two thread lifecycle events + 197 own comments + verdict = a full page.
    for (let i = 0; i < 197; i++) comment("claude", opened.thread_id);
    approve(opened);
    let calls = 0;
    const runner = scheduler(async () => {
      calls++;
      hub.store.resolve(hub.claude, { idempotencyKey: key(), threadId: opened.thread_id, expectedRevisionId: opened.revision_id, outcome: "resolved", summary: "Approved" });
      return { status: "completed", output: "Resolved" };
    });
    expect(await runner.tick()).toBe(false);
    expect(await runner.tick()).toBe(true);
    expect(await runner.tick()).toBe(false);
    expect(calls).toBe(1);
  });

  it("accepts a no-op only when the delivered review became stale during the invocation", async () => {
    config.agents = [config.agents[1]!];
    const opened = review();
    let calls = 0;
    const runner = scheduler(async () => {
      calls++;
      if (calls === 1) hub.store.submitRevision(hub.claude, { idempotencyKey: key(), threadId: opened.thread_id, contentType: "patch", content: PATCH_R1 + "\n// supersedes" });
      else {
        const request = hub.store.threadSummary(opened.thread_id).current_round_requests[0]!;
        approve(opened, hub.codex, request.id);
      }
      return { status: "completed", output: "Request changed while reading" };
    });
    expect(await runner.tick()).toBe(true);
    expect(state.getAgent(config.workspace, hub.codex.participantId).blockedReason).toBeNull();
    expect(await runner.tick()).toBe(true);
    expect(await runner.tick()).toBe(false);
    expect(calls).toBe(2);
  });

  it("parks budget-exhausted thread work across restarts while servicing another thread, then retries without duplicates", async () => {
    config.agents = [config.agents[1]!];
    config.maxTurnsPerThread = 1;
    const first = review();
    const seen: string[] = [];
    const runner = scheduler(async () => { seen.push(first.thread_id); question(first.thread_id); return { status: "completed", output: "Asked" }; });
    expect(await runner.tick()).toBe(true);
    comment("claude", first.thread_id);
    const second = review();
    const resumed = scheduler(async (context) => {
      const target = context.prompt.includes(second.thread_id) ? second : first;
      seen.push(target.thread_id);
      approve(target);
      return { status: "completed", output: "Approved" };
    });
    expect(await resumed.tick()).toBe(true);
    expect(seen).toEqual([first.thread_id, second.thread_id]);
    expect(state.getAgent(config.workspace, hub.codex.participantId).blockedReason).toBeNull();
    expect(state.status(config.workspace).deferredThreads).toEqual([expect.objectContaining({ agentId: hub.codex.participantId, threadId: first.thread_id, blockedReason: expect.stringMatching(/budget/i) })]);
    state.close(); state = new RunnerState(hub.file);
    expect(state.getBudget(config.workspace, first.thread_id)).toBe(1);
    const oldCursor = state.getAgent(config.workspace, hub.codex.participantId).cursor;
    state.retry(config.workspace, hub.codex.participantId);
    const restarted = scheduler(async (context) => {
      expect(context.prompt).toContain(first.thread_id);
      seen.push(first.thread_id); approve(first);
      return { status: "completed", output: "Approved" };
    });
    expect(await restarted.tick()).toBe(false);
    state.retry(config.workspace, hub.codex.participantId, first.thread_id, 1);
    expect(state.getAgent(config.workspace, hub.codex.participantId).cursor).toBeGreaterThanOrEqual(oldCursor);
    expect(await restarted.tick()).toBe(true);
    expect(await restarted.tick()).toBe(false);
    expect(seen).toEqual([first.thread_id, second.thread_id, first.thread_id]);
    expect(state.getBudget(config.workspace, first.thread_id)).toBe(2);
    expect(state.status(config.workspace).deferredThreads).toEqual([]);
  });

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
      if (calls === 1) question(opened.thread_id); else approve(opened);
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
      hub.store.post(hub.codex, { idempotencyKey: key(), threadId: opened.thread_id, kind: "verdict", verdict: "approve", body: "Approved", responseRequestId: newer.request_ids[0] });
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
      if (progress) approve(opened);
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
      question(opened.thread_id);
      return { status: "completed", output: "Done" };
    });
    expect(await runner.tick()).toBe(true);
    comment("claude", opened.thread_id);
    const restarted = scheduler(async () => { throw new Error("Budget must prevent this call"); });
    expect(await restarted.tick()).toBe(false);
    expect(state.getAgent(config.workspace, hub.codex.participantId).blockedReason).toBeNull();
    expect(state.status(config.workspace).deferredThreads[0]?.blockedReason).toMatch(/budget|limit/i);
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
      approve(opened);
      return { status: "completed", output: "Done" };
    });
    expect(await runner.tick()).toBe(false);
    expect(await runner.tick()).toBe(true);
  });
});
