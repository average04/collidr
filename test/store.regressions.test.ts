import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubmitRevisionResult } from "../src/store.js";
import { PATCH_R1, PATCH_R2, key, makeHub, type Hub } from "./helpers.js";

let hub: Hub;
beforeEach(() => {
  hub = makeHub();
});
afterEach(() => {
  vi.restoreAllMocks();
  hub.close();
});

function openReview() {
  return hub.store.openThread(hub.claude, {
    idempotencyKey: key("open"),
    workspaceId: hub.workspaceId,
    type: "diff_review",
    title: "Fix sum()",
    reviewers: [hub.codex.participantId],
    participants: [{ participantId: hub.gemini.participantId, role: "observer" }],
    contentType: "patch",
    content: PATCH_R1,
  });
}

describe("directed message history", () => {
  it("includes the sender's directed message in history without exposing it to other participants", () => {
    const { store, claude, codex, gemini } = hub;
    const opened = openReview();
    const stranger = store.register({ participantId: "stranger" }).participant;
    const afterSeq = store.maxSeq();
    const posted = store.post(claude, {
      idempotencyKey: key("directed"),
      threadId: opened.thread_id,
      kind: "question",
      body: "Please check the negative-number case.",
      recipients: [codex.participantId],
    });
    const historyOptions = { afterSeq, threadId: opened.thread_id, includeOwn: true };
    const expectedMessage = {
      type: "message_posted",
      message: {
        id: posted.message_id,
        sender_id: claude.participantId,
        body: "Please check the negative-number case.",
        recipients: [codex.participantId],
      },
    };

    expect(store.listVisibleEvents(claude.participantId, historyOptions).events).toMatchObject([expectedMessage]);
    expect(store.listVisibleEvents(codex.participantId, historyOptions).events).toMatchObject([expectedMessage]);
    expect(store.listVisibleEvents(gemini.participantId, historyOptions).events).toEqual([]);
    expect(store.listVisibleEvents(stranger.id, historyOptions).events).toEqual([]);
    expect(store.listVisibleEvents(claude.participantId).events).toEqual([]);
  });
});

describe("thread summary snapshots", () => {
  it("keeps round, revision, requests, and awaiting from one snapshot when another connection submits a revision", () => {
    const { store, claude, codex, gemini } = hub;
    const opened = openReview();
    const writer = hub.reopen();
    const getThread = store.getThread.bind(store);
    let revision: SubmitRevisionResult | undefined;

    // Schedule a real WAL commit after the first read. The spy returns the actual
    // row; only the interleaving is controlled, never any database result.
    vi.spyOn(store, "getThread").mockImplementationOnce((threadId) => {
      const thread = getThread(threadId);
      revision = writer.submitRevision(claude, {
        idempotencyKey: key("revision"),
        threadId,
        contentType: "patch",
        content: PATCH_R2,
        reviewers: [gemini.participantId],
      });
      return thread;
    });

    const duringCommit = store.threadSummary(opened.thread_id);
    expect(duringCommit).toMatchObject({
      thread: { current_round: 1, status: "open" },
      latest_revision: { id: opened.revision_id, number: 1, round: 1 },
      current_round_requests: [{
        id: opened.request_ids[0],
        round: 1,
        target_revision_id: opened.revision_id,
        assignee_id: codex.participantId,
        status: "open",
      }],
      awaiting: [codex.participantId],
      resolution: null,
    });

    expect(revision).toBeDefined();
    const afterCommit = store.threadSummary(opened.thread_id);
    expect(afterCommit).toMatchObject({
      thread: { current_round: 2, status: "open" },
      latest_revision: { id: revision!.revision_id, number: 2, round: 2 },
      current_round_requests: [{
        id: revision!.request_ids[0],
        round: 2,
        target_revision_id: revision!.revision_id,
        assignee_id: gemini.participantId,
        status: "open",
      }],
      awaiting: [gemini.participantId],
      resolution: null,
    });
  });

  it("keeps status, resolution, and pending requests from one snapshot when another connection resolves the thread", () => {
    const { store, claude, codex } = hub;
    const opened = openReview();
    const writer = hub.reopen();
    const getThread = store.getThread.bind(store);

    vi.spyOn(store, "getThread").mockImplementationOnce((threadId) => {
      const thread = getThread(threadId);
      writer.resolve(claude, {
        idempotencyKey: key("resolve"),
        threadId,
        expectedRevisionId: opened.revision_id,
        outcome: "resolved",
        summary: "Verified the fix.",
      });
      return thread;
    });

    const duringCommit = store.threadSummary(opened.thread_id);
    expect(duringCommit).toMatchObject({
      thread: { current_round: 1, status: "open", closed_at: null },
      latest_revision: { id: opened.revision_id, number: 1, round: 1 },
      current_round_requests: [{ id: opened.request_ids[0], status: "open" }],
      awaiting: [codex.participantId],
      resolution: null,
    });

    const afterCommit = store.threadSummary(opened.thread_id);
    expect(afterCommit).toMatchObject({
      thread: { current_round: 1, status: "resolved", closed_at: expect.any(String) },
      latest_revision: { id: opened.revision_id, number: 1, round: 1 },
      current_round_requests: [{ id: opened.request_ids[0], status: "cancelled" }],
      awaiting: [],
      resolution: {
        resolved_revision_id: opened.revision_id,
        outcome: "resolved",
        summary: "Verified the fix.",
        resolved_by: claude.participantId,
      },
    });
  });
});
