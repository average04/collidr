import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunnerState } from "../src/runner/state.js";
import { makeHub, type Hub } from "./helpers.js";

let hub: Hub;
let states: RunnerState[];
const workspace = "/repo/collidr";
beforeEach(() => { hub = makeHub(); states = []; });
afterEach(() => { for (const state of states) state.close(); hub.close(); });
function open() { const state = new RunnerState(hub.file); states.push(state); return state; }
function expireLease() {
  const db = new Database(`${hub.file}.runner.db`);
  db.prepare("UPDATE runner_leases SET heartbeat_at = ?").run(Date.now() - 20_000);
  db.close();
}

describe("durable runner state", () => {
  it("refuses newer sidecar schemas without changing their tables", () => {
    const db = new Database(`${hub.file}.runner.db`);
    db.pragma("user_version = 2");
    db.exec("CREATE TABLE future_state (value TEXT)");
    db.close();
    expect(() => open()).toThrow(/newer|version/i);
    const check = new Database(`${hub.file}.runner.db`);
    try {
      expect(check.pragma("user_version", { simple: true })).toBe(2);
      expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([{ name: "future_state" }]);
    } finally { check.close(); }
  });

  it("rolls back schema initialization if an existing sidecar has conflicting tables", () => {
    const db = new Database(`${hub.file}.runner.db`);
    db.exec("CREATE TABLE runner_tasks (id TEXT)");
    db.close();
    expect(() => open()).toThrow();
    const check = new Database(`${hub.file}.runner.db`);
    try {
      expect(check.pragma("user_version", { simple: true })).toBe(0);
      expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([{ name: "runner_tasks" }]);
    } finally { check.close(); }
  });

  it("excludes another owner even after heartbeat expiry while the original process is alive", () => {
    const first = open();
    const second = open();
    expect(first.acquire(workspace, "first")).toBe(true);
    expect(second.acquire(workspace, "second")).toBe(false);
    expireLease();
    expect(second.acquire(workspace, "second")).toBe(false);
    first.release(workspace, "wrong-owner");
    expect(second.acquire(workspace, "second")).toBe(false);
    first.release(workspace, "first");
    expect(second.acquire(workspace, "second")).toBe(true);
    expect(hub.store.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'runner_%'").all()).toEqual([]);
  });

  it("persists session, checkpoints, output and queued tasks across restarts without sharing hub acknowledgements", () => {
    const first = open();
    first.ensureAgent(workspace, "codex");
    first.advance(workspace, "codex", 7);
    first.advance(workspace, "codex", 2);
    const taskId = first.enqueue(workspace, "codex", "Review the change");
    const run = first.beginRun(workspace, "codex", { taskId, threadId: null, eventSeq: null }, 12)!;
    first.setSession(workspace, "codex", run.id, "exact-session-id");
    first.finishRun(workspace, "codex", run.id, { status: "completed", output: "Posted review" });
    const second = open();
    expect(second.getAgent(workspace, "codex")).toMatchObject({ cursor: 7, sessionId: "exact-session-id", output: "Posted review", active: null });
    expect(second.status(workspace).tasks).toEqual([expect.objectContaining({ id: taskId, status: "completed" })]);
    expect(hub.store.getCursors(hub.codex.participantId)).toEqual({});
  });

  it("recovers dead supervisors as blocked work with the checkpoint retained, then retries explicitly", () => {
    const first = open();
    first.acquire(workspace, "dead", 2147483647);
    first.ensureAgent(workspace, "codex");
    first.advance(workspace, "codex", 4);
    const taskId = first.enqueue(workspace, "codex", "Review");
    const run = first.beginRun(workspace, "codex", { taskId, threadId: null, eventSeq: null }, 12)!;
    first.setSession(workspace, "codex", run.id, "saved-before-crash");
    expireLease();
    const second = open();
    expect(second.acquire(workspace, "replacement")).toBe(true);
    expect(second.getAgent(workspace, "codex")).toMatchObject({ cursor: 4, sessionId: "saved-before-crash", blockedReason: expect.stringMatching(/interrupt/i), active: null });
    expect(second.pendingTask(workspace, "codex")).toBeNull();
    second.retry(workspace, "codex");
    expect(second.pendingTask(workspace, "codex")?.id).toBe(taskId);
    expect(second.getAgent(workspace, "codex").blockedReason).toBeNull();
  });

  it("does not take over a dead supervisor's live child or allow overlapping workspace runs", () => {
    const first = open();
    first.acquire(workspace, "dead", 2147483647);
    first.ensureAgent(workspace, "a");
    first.ensureAgent(workspace, "b");
    const run = first.beginRun(workspace, "a", { taskId: null, threadId: "thread", eventSeq: 3 }, 12)!;
    first.setChild(workspace, "a", run.id, process.pid);
    expireLease();
    const second = open();
    expect(second.acquire(workspace, "replacement")).toBe(false);
    expect(second.beginRun(workspace, "b", { taskId: null, threadId: "other", eventSeq: 4 }, 12)).toBeNull();
    expect(() => second.retry(workspace, "a")).toThrow(/active|running|child/i);
  });

  it("stop requests are durable and owner-scoped release cannot erase another lease", () => {
    const first = open();
    const second = open();
    first.acquire(workspace, "first");
    expect(first.shouldStop(workspace, "first")).toBe(false);
    second.requestStop(workspace);
    expect(first.shouldStop(workspace, "first")).toBe(true);
    expect(first.shouldStop(workspace, "unknown")).toBe(true);
    second.release(workspace, "unknown");
    expect(second.status(workspace).lease?.owner).toBe("first");
    first.release(workspace, "first");
    expect(second.acquire(workspace, "second")).toBe(true);
    expect(second.shouldStop(workspace, "second")).toBe(false);
  });

  it("persists a shared per-thread invocation budget across sessions and agents", () => {
    const state = open();
    state.ensureAgent(workspace, "a");
    state.ensureAgent(workspace, "b");
    const run = state.beginRun(workspace, "a", { taskId: null, threadId: "thread", eventSeq: 1 }, 1)!;
    state.finishRun(workspace, "a", run.id, { status: "completed", output: "done" });
    const second = open();
    expect(second.beginRun(workspace, "b", { taskId: null, threadId: "thread", eventSeq: 2 }, 1)).toBeNull();
    expect(second.getAgent(workspace, "b").blockedReason).toMatch(/budget|limit/i);
    expect(second.getBudget(workspace, "thread")).toBe(1);
  });

  it("delivers queued tasks in submission order even when their ULID timestamps match", () => {
    const state = open();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    let ids: string[];
    try { ids = Array.from({ length: 20 }, (_, index) => state.enqueue(workspace, "a", `Task ${index}`)); }
    finally { clock.mockRestore(); }
    for (const id of ids) {
      expect(state.pendingTask(workspace, "a")?.id).toBe(id);
      const active = state.beginRun(workspace, "a", { taskId: id, threadId: null, eventSeq: null }, 12)!;
      state.finishRun(workspace, "a", active.id, { status: "completed", output: "Done" });
    }
  });

  it("refuses to resume an existing session through a different provider", () => {
    const state = open();
    state.ensureAgent(workspace, "managed", "claude");
    const active = state.beginRun(workspace, "managed", { taskId: null, threadId: null, eventSeq: null }, 12)!;
    state.setSession(workspace, "managed", active.id, "claude-session");
    state.finishRun(workspace, "managed", active.id, { status: "completed", output: "Done" });
    const second = open();
    expect(() => second.ensureAgent(workspace, "managed", "codex")).toThrow(/provider|session/i);
    expect(second.getAgent(workspace, "managed").sessionId).toBe("claude-session");
  });
});
