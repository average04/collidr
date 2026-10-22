import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunnerState } from "../src/runner/state.js";
import { makeHub, type Hub } from "./helpers.js";

// PID recycling is an OS event we cannot trigger reliably. Keep SQLite and
// identity comparison real, replacing only the process birth observations.
const births = vi.hoisted(() => new Map<number, string | null>());
const observations = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/runner/process-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runner/process-identity.js")>();
  const identity = (pid: number) => { observations.count++; return births.get(pid) ?? null; };
  return {
    ...actual,
    captureProcessIdentity: identity,
    processMatchesIdentity: (pid: number, expected: string | null | undefined) =>
      actual.processMatchesIdentity(pid, expected, { alive: actual.processAlive, identity }),
  };
});

let hub: Hub;
let states: RunnerState[];
const workspace = "/repo/collidr";
beforeEach(() => {
  hub = makeHub(); states = [];
  births.clear(); births.set(process.pid, "original-process"); observations.count = 0;
});
afterEach(() => { vi.restoreAllMocks(); for (const state of states) state.close(); hub.close(); });
const open = () => { const state = new RunnerState(hub.file); states.push(state); return state; };
function edit(sql: string) {
  const db = new Database(`${hub.file}.runner.db`);
  try { db.exec(sql); } finally { db.close(); }
}
const expire = () => edit(`UPDATE runner_leases SET heartbeat_at = ${Date.now() - 20_000}`);

describe("runner process ownership across PID reuse", () => {
  it("persists supervisor identity and protects the same live owner after expiry", () => {
    const first = open();
    expect(first.acquire(workspace, "first")).toBe(true);
    expect(open().status(workspace).lease).toMatchObject({ processIdentity: "original-process" });
    expire();
    expect(open().acquire(workspace, "second")).toBe(false);
  });

  it("recovers an expired lease when its PID now belongs to a different process", () => {
    const first = open(); first.acquire(workspace, "first");
    births.set(process.pid, "replacement-process");
    const second = open();
    expect(second.acquire(workspace, "second")).toBe(false); // recent heartbeat still protects startup
    expire();
    expect(second.acquire(workspace, "second")).toBe(true);
    expect(second.status(workspace).lease).toMatchObject({ owner: "second", processIdentity: "replacement-process" });
  });

  it("does not mistake a recycled child PID for unfinished work during crash recovery", () => {
    const first = open(); first.acquire(workspace, "dead", 2147483647);
    const run = first.beginRun(workspace, "agent", { taskId: null, threadId: "review", eventSeq: 4 }, 12)!;
    first.setChild(workspace, "agent", run.id, process.pid);
    expect(first.getAgent(workspace, "agent").active).toMatchObject({ childIdentity: "original-process" });
    expire();
    expect(open().acquire(workspace, "replacement")).toBe(false);
    births.set(process.pid, "unrelated-process");
    const recovered = open();
    expect(recovered.acquire(workspace, "replacement")).toBe(true);
    expect(recovered.getAgent(workspace, "agent")).toMatchObject({ active: null, cursor: 0, blockedReason: expect.stringMatching(/interrupt/i) });
  });

  it("clears settled owned-child evidence without killing an unrelated reused PID", () => {
    const state = open();
    const run = state.beginRun(workspace, "agent", { taskId: null, threadId: "review", eventSeq: 4 }, 12)!;
    state.setChild(workspace, "agent", run.id, process.pid);
    state.finishRun(workspace, "agent", run.id, { status: "blocked", reason: "cleanup pending", output: "", keepActive: true });
    state.reapExitedChildren(workspace);
    expect(state.getAgent(workspace, "agent").active).not.toBeNull();
    births.set(process.pid, "unrelated-process");
    state.clearSettledRun(workspace, "agent", run.id);
    expect(state.getAgent(workspace, "agent").active).toBeNull();
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  it("bounds periodic birth probes while eventually recovering a recycled child PID", () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const state = open();
    const run = state.beginRun(workspace, "agent", { taskId: null, threadId: "review", eventSeq: 4 }, 12)!;
    state.setChild(workspace, "agent", run.id, process.pid);
    state.finishRun(workspace, "agent", run.id, { status: "blocked", reason: "cleanup pending", output: "", keepActive: true });
    state.reapExitedChildren(workspace);
    const firstLookupCount = observations.count;
    for (let i = 0; i < 10; i++) { now += 100; state.reapExitedChildren(workspace); }
    expect(observations.count).toBe(firstLookupCount);
    expect(state.getAgent(workspace, "agent").active).not.toBeNull();
    births.set(process.pid, "unrelated-process");
    now += 6000;
    state.reapExitedChildren(workspace);
    expect(state.getAgent(workspace, "agent").active).toBeNull();
  });

  it("migrates legacy leases without inventing an identity or losing queued work", () => {
    const first = open();
    first.acquire(workspace, "legacy-owner");
    const taskId = first.enqueue(workspace, "agent", "Preserve this task");
    first.advance(workspace, "agent", 12);
    first.close();
    edit("ALTER TABLE runner_leases DROP COLUMN process_identity; PRAGMA user_version = 2;");
    const migrated = open();
    expect(migrated.status(workspace).lease).toMatchObject({ owner: "legacy-owner", processIdentity: null });
    expect(migrated.pendingTask(workspace, "agent")?.id).toBe(taskId);
    expect(migrated.getAgent(workspace, "agent").cursor).toBe(12);
    expire();
    expect(migrated.acquire(workspace, "second")).toBe(false);
  });

  it("keeps unknown or legacy identities conservative instead of allowing overlap", () => {
    const state = open(); state.acquire(workspace, "first");
    expire(); births.set(process.pid, null);
    expect(open().acquire(workspace, "second")).toBe(false);
    edit("UPDATE runner_leases SET process_identity = NULL");
    births.set(process.pid, "different-process");
    expect(open().acquire(workspace, "second")).toBe(false);
  });
});
