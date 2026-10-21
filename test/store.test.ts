import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollidrError } from "../src/errors.js";
import { MAX_CONTENT_BYTES, sha256 } from "../src/store.js";
import { PATCH_R1, PATCH_R2, key, makeHub, type Hub } from "./helpers.js";

let hub: Hub;
beforeEach(() => {
  hub = makeHub();
});
afterEach(() => hub.close());

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CollidrError);
    expect((err as CollidrError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

function openReview(opts: { reviewers?: string[]; roundLimit?: number } = {}) {
  return hub.store.openThread(hub.claude, {
    idempotencyKey: key("open"),
    workspaceId: hub.workspaceId,
    type: "diff_review",
    title: "Fix sum()",
    reviewers: opts.reviewers ?? [hub.codex.participantId],
    roundLimit: opts.roundLimit,
    contentType: "patch",
    content: PATCH_R1,
    baseCommit: "aaa111",
    headCommit: "bbb222",
  });
}

describe("happy path: Claude ↔ Codex diff review (spec §9)", () => {
  it("runs a full two-revision review to resolution", () => {
    const { store, claude, codex } = hub;
    const opened = openReview();
    expect(opened.request_ids).toHaveLength(1);

    // Codex sees the review request in its inbox, with no message involved.
    const inbox = store.listVisibleEvents(codex.participantId);
    const created = inbox.events.find((e) => e.type === "request_created");
    expect(created?.request?.assignee_id).toBe(codex.participantId);

    // Codex reads r1 through the store (what read_revision exposes over MCP).
    const page = store.readRevision(codex.participantId, opened.thread_id, opened.revision_id);
    expect(page.lines.join("\n")).toBe(PATCH_R1);
    expect(page.revision.content_hash).toBe(sha256(PATCH_R1));

    store.post(codex, {
      idempotencyKey: key(),
      threadId: opened.thread_id,
      kind: "comment",
      body: "Add a test for negatives.",
      revisionId: opened.revision_id,
      anchors: [{ path: "src/sum.ts", line_start: 2 }],
    });
    const changes = store.post(codex, {
      idempotencyKey: `verdict:${opened.request_ids[0]}`,
      threadId: opened.thread_id,
      kind: "verdict",
      verdict: "request_changes",
      body: "Needs the negative-number case.",
      responseRequestId: opened.request_ids[0],
    });
    expect(changes.completed_request_id).toBe(opened.request_ids[0]);

    const r2 = store.submitRevision(claude, {
      idempotencyKey: key("rev"),
      threadId: opened.thread_id,
      contentType: "patch",
      content: PATCH_R2,
    });
    expect(r2.number).toBe(2);
    expect(r2.request_ids).toHaveLength(1); // Codex re-requested by default
    expect(r2.superseded_request_ids).toEqual([]); // r1's request was already completed
    expect(store.getRequest(opened.request_ids[0]!).status).toBe("completed");

    const summary = store.threadSummary(opened.thread_id);
    expect(summary.latest_revision.number).toBe(2);
    expect(summary.awaiting).toEqual([codex.participantId]);

    store.post(codex, {
      idempotencyKey: `verdict:${r2.request_ids[0]}`,
      threadId: opened.thread_id,
      kind: "verdict",
      verdict: "approve",
      body: "LGTM.",
      responseRequestId: r2.request_ids[0],
    });
    const resolved = store.resolve(claude, {
      idempotencyKey: key("resolve"),
      threadId: opened.thread_id,
      expectedRevisionId: r2.revision_id,
      outcome: "resolved",
      summary: "Fixed and approved.",
    });
    expect(resolved.resolved_revision_id).toBe(r2.revision_id);
    expect(store.getThread(opened.thread_id).status).toBe("resolved");
    expect(store.getResolution(opened.thread_id)?.resolved_by).toBe(claude.participantId);
  });
});

describe("revisions and review requests (spec §6)", () => {
  it("creates review requests atomically with r1 and rejects an empty reviewer set", () => {
    expectCode(() => openReview({ reviewers: [] }), "no_reviewers");
    // Nothing was created by the failed call.
    expect(hub.store.db.prepare("SELECT COUNT(*) AS n FROM threads").get()).toEqual({ n: 0 });
    expect(hub.store.db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
  });

  it("rejects explicitly empty reviewers on submit_revision", () => {
    const t = openReview();
    expectCode(
      () =>
        hub.store.submitRevision(hub.claude, {
          idempotencyKey: key(),
          threadId: t.thread_id,
          contentType: "patch",
          content: PATCH_R2,
          reviewers: [],
        }),
      "no_reviewers",
    );
  });

  it("supersedes a still-open r1 request when r2 arrives", () => {
    const t = openReview();
    const r2 = hub.store.submitRevision(hub.claude, {
      idempotencyKey: key(),
      threadId: t.thread_id,
      contentType: "patch",
      content: PATCH_R2,
    });
    expect(r2.superseded_request_ids).toEqual(t.request_ids);
    expect(hub.store.getRequest(t.request_ids[0]!).status).toBe("superseded");
    const types = hub.store.listVisibleEvents(hub.codex.participantId).events.map((e) => e.type);
    expect(types).toContain("request_superseded");
  });

  it("rejects a non-verdict post that carries a request ID and leaves the request open", () => {
    const t = openReview();
    expectCode(
      () =>
        hub.store.post(hub.codex, {
          idempotencyKey: key(),
          threadId: t.thread_id,
          kind: "question",
          body: "Why subtract?",
          responseRequestId: t.request_ids[0],
        }),
      "verdict_required",
    );
    expect(hub.store.getRequest(t.request_ids[0]!).status).toBe("open");
  });

  it("only lets the assignee complete a request, and only once", () => {
    const t = openReview({ reviewers: [hub.codex.participantId, hub.gemini.participantId] });
    const codexReq = t.request_ids.find((id) => hub.store.getRequest(id).assignee_id === hub.codex.participantId)!;
    expectCode(
      () =>
        hub.store.post(hub.gemini, {
          idempotencyKey: key(),
          threadId: t.thread_id,
          kind: "verdict",
          verdict: "approve",
          body: "ok",
          responseRequestId: codexReq,
        }),
      "not_assignee",
    );
    hub.store.post(hub.codex, {
      idempotencyKey: key(),
      threadId: t.thread_id,
      kind: "verdict",
      verdict: "approve",
      body: "ok",
      responseRequestId: codexReq,
    });
    expectCode(
      () =>
        hub.store.post(hub.codex, {
          idempotencyKey: key(),
          threadId: t.thread_id,
          kind: "verdict",
          verdict: "approve",
          body: "again",
          responseRequestId: codexReq,
        }),
      "request_not_open",
    );
  });

  it("rejects a verdict aimed at a different revision than its request", () => {
    const t = openReview();
    hub.store.submitRevision(hub.claude, {
      idempotencyKey: key(),
      threadId: t.thread_id,
      contentType: "patch",
      content: PATCH_R2,
    });
    // r1's request is superseded now, so completing it fails.
    expectCode(
      () =>
        hub.store.post(hub.codex, {
          idempotencyKey: key(),
          threadId: t.thread_id,
          kind: "verdict",
          verdict: "approve",
          body: "ok",
          responseRequestId: t.request_ids[0],
        }),
      "request_not_open",
    );
  });

  it("rejects oversized content", () => {
    const big = "x".repeat(MAX_CONTENT_BYTES + 1);
    expectCode(
      () =>
        hub.store.openThread(hub.claude, {
          idempotencyKey: key(),
          workspaceId: hub.workspaceId,
          type: "plan_review",
          title: "huge",
          reviewers: [hub.codex.participantId],
          contentType: "plan",
          content: big,
        }),
      "content_too_large",
    );
  });

  it("pages revision content without moving any event cursor", () => {
    const content = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n");
    const t = hub.store.openThread(hub.claude, {
      idempotencyKey: key(),
      workspaceId: hub.workspaceId,
      type: "plan_review",
      title: "Plan",
      reviewers: [hub.codex.participantId],
      contentType: "plan",
      content,
    });
    hub.store.ack(hub.codex.participantId, "inbox", 1);
    const before = hub.store.getCursors(hub.codex.participantId);

    const seen: string[] = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page = hub.store.readRevision(hub.codex.participantId, t.thread_id, t.revision_id, {
        contentCursor: cursor,
        limit: 10,
      });
      seen.push(...page.lines);
      cursor = page.content_cursor;
    }
    expect(seen.join("\n")).toBe(content);
    expect(hub.store.getCursors(hub.codex.participantId)).toEqual(before);
  });
});

describe("rounds and automatic closure (spec §6)", () => {
  it("with round_limit=1, blocks a second revision but lets the single review finish", () => {
    const t = openReview({ roundLimit: 1 });
    expectCode(
      () =>
        hub.store.submitRevision(hub.claude, {
          idempotencyKey: key(),
          threadId: t.thread_id,
          contentType: "patch",
          content: PATCH_R2,
        }),
      "round_limit_reached",
    );
    const res = hub.store.post(hub.codex, {
      idempotencyKey: key(),
      threadId: t.thread_id,
      kind: "verdict",
      verdict: "approve",
      body: "ok",
      responseRequestId: t.request_ids[0],
    });
    expect(res.thread_status).toBe("resolved");
    const resolution = hub.store.getResolution(t.thread_id)!;
    expect(resolution.resolved_by).toBeNull();
    expect(resolution.resolved_revision_id).toBe(t.revision_id);
  });

  it("does not close the final round until every required review has a verdict", () => {
    const t = openReview({ roundLimit: 1, reviewers: [hub.codex.participantId, hub.gemini.participantId] });
    const [a, b] = t.request_ids.map((id) => hub.store.getRequest(id));
    const actorFor = (assignee: string) => (assignee === hub.codex.participantId ? hub.codex : hub.gemini);
    const first = hub.store.post(actorFor(a!.assignee_id), {
      idempotencyKey: key(),
      threadId: t.thread_id,
      kind: "verdict",
      verdict: "approve",
      body: "ok",
      responseRequestId: a!.id,
    });
    expect(first.thread_status).toBe("open");
    const second = hub.store.post(actorFor(b!.assignee_id), {
      idempotencyKey: key(),
      threadId: t.thread_id,
      kind: "verdict",
      verdict: "request_changes",
      body: "Not yet.",
      responseRequestId: b!.id,
    });
    expect(second.thread_status).toBe("unresolved");
    const resolution = hub.store.getResolution(t.thread_id)!;
    expect(resolution.outcome).toBe("unresolved");
    expect(resolution.outstanding_objections).toHaveLength(1);
  });

  it("never treats superseded requests as approvals", () => {
    const t = openReview({ roundLimit: 2 });
    const r2 = hub.store.submitRevision(hub.claude, {
      idempotencyKey: key(),
      threadId: t.thread_id,
      contentType: "patch",
      content: PATCH_R2,
    });
    expect(hub.store.getRequest(t.request_ids[0]!).status).toBe("superseded");
    const res = hub.store.post(hub.codex, {
      idempotencyKey: key(),
      threadId: t.thread_id,
      kind: "verdict",
      verdict: "request_changes",
      body: "still wrong",
      responseRequestId: r2.request_ids[0],
    });
    expect(res.thread_status).toBe("unresolved");
  });

  it("keeps a thread open after a non-final round completes", () => {
    const t = openReview({ roundLimit: 3 });
    const res = hub.store.post(hub.codex, {
      idempotencyKey: key(),
      threadId: t.thread_id,
      kind: "verdict",
      verdict: "approve",
      body: "ok",
      responseRequestId: t.request_ids[0],
    });
    expect(res.thread_status).toBe("open");
  });
});

describe("resolution and closed threads (spec §6)", () => {
  it("rejects resolve against a stale revision", () => {
    const t = openReview();
    hub.store.submitRevision(hub.claude, {
      idempotencyKey: key(),
      threadId: t.thread_id,
      contentType: "patch",
      content: PATCH_R2,
    });
    expectCode(
      () =>
        hub.store.resolve(hub.claude, {
          idempotencyKey: key(),
          threadId: t.thread_id,
          expectedRevisionId: t.revision_id,
          outcome: "resolved",
          summary: "done",
        }),
      "stale_revision",
    );
  });

  it("only lets the author resolve", () => {
    const t = openReview();
    expectCode(
      () =>
        hub.store.resolve(hub.codex, {
          idempotencyKey: key(),
          threadId: t.thread_id,
          expectedRevisionId: t.revision_id,
          outcome: "resolved",
          summary: "done",
        }),
      "forbidden",
    );
  });

  it("cancels open requests at close and rejects further writes", () => {
    const t = openReview();
    hub.store.resolve(hub.claude, {
      idempotencyKey: key(),
      threadId: t.thread_id,
      expectedRevisionId: t.revision_id,
      outcome: "unresolved",
      summary: "abandoned",
    });
    expect(hub.store.getRequest(t.request_ids[0]!).status).toBe("cancelled");
    expectCode(
      () => hub.store.post(hub.codex, { idempotencyKey: key(), threadId: t.thread_id, kind: "comment", body: "hi" }),
      "thread_closed",
    );
    expectCode(
      () =>
        hub.store.submitRevision(hub.claude, {
          idempotencyKey: key(),
          threadId: t.thread_id,
          contentType: "patch",
          content: PATCH_R2,
        }),
      "thread_closed",
    );
  });
});

describe("idempotency and recovery (spec §5)", () => {
  it("returns the original result for a retried write, including after a reopen", () => {
    const t = openReview();
    const input = {
      idempotencyKey: "comment-1",
      threadId: t.thread_id,
      kind: "comment" as const,
      body: "First thought.",
    };
    const a = hub.store.post(hub.codex, input);
    // Simulate a lost response + restart: a different Store (process) retries.
    const other = hub.reopen();
    const b = other.post(hub.codex, input);
    expect(b.message_id).toBe(a.message_id);
    expect(other.db.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 });
  });

  it("returns r2 (not r3) when submit_revision is retried", () => {
    const t = openReview();
    const input = { idempotencyKey: "rev-2", threadId: t.thread_id, contentType: "patch" as const, content: PATCH_R2 };
    const a = hub.store.submitRevision(hub.claude, input);
    const b = hub.store.submitRevision(hub.claude, input);
    expect(b).toEqual(a);
    expect(hub.store.latestRevision(t.thread_id).number).toBe(2);
  });

  it("rejects reuse of a key with different arguments", () => {
    const t = openReview();
    hub.store.post(hub.codex, { idempotencyKey: "same", threadId: t.thread_id, kind: "comment", body: "one" });
    expectCode(
      () => hub.store.post(hub.codex, { idempotencyKey: "same", threadId: t.thread_id, kind: "comment", body: "two" }),
      "idempotency_conflict",
    );
  });

  it("replays unacknowledged events after a crash without duplicating the reply", () => {
    const t = openReview();
    const inbox1 = hub.store.listVisibleEvents(hub.codex.participantId, { afterSeq: 0 });
    // Codex replies, then crashes before acking.
    const replyKey = `verdict:${t.request_ids[0]}`;
    hub.store.post(hub.codex, {
      idempotencyKey: replyKey,
      threadId: t.thread_id,
      kind: "verdict",
      verdict: "approve",
      body: "ok",
      responseRequestId: t.request_ids[0],
    });

    // Restart: a new process re-registers and resumes from the saved cursor (none).
    const other = hub.reopen();
    const { session, cursors } = other.register({ participantId: hub.codex.participantId, model: "gpt-codex-2" });
    expect(cursors.inbox ?? 0).toBe(0);
    const inbox2 = other.listVisibleEvents(hub.codex.participantId, { afterSeq: cursors.inbox ?? 0 });
    expect(inbox2.events.map((e) => e.seq)).toEqual(inbox1.events.map((e) => e.seq));

    // It handles the replayed request again with the same derived key: no duplicate.
    const again = other.post(
      { participantId: hub.codex.participantId, sessionId: session.id },
      {
        idempotencyKey: replyKey,
        threadId: t.thread_id,
        kind: "verdict",
        verdict: "approve",
        body: "ok",
        responseRequestId: t.request_ids[0],
      },
    );
    expect(again.completed_request_id).toBe(t.request_ids[0]);
    expect(other.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind = 'verdict'").get()).toEqual({ n: 1 });
  });

  it("never moves a cursor backward, and shares cursors across sessions", () => {
    const { store, codex } = hub;
    openReview();
    const max = store.maxSeq();
    expect(store.ack(codex.participantId, "inbox", max)).toBe(max);
    expect(store.ack(codex.participantId, "inbox", 1)).toBe(max);
    const { cursors } = store.register({ participantId: codex.participantId });
    expect(cursors.inbox).toBe(max);
  });
});

describe("delivery and attribution", () => {
  it("delivers a review request with no message to the assignee's inbox, but not the author's own events", () => {
    openReview();
    const codexTypes = hub.store.listVisibleEvents(hub.codex.participantId).events.map((e) => e.type);
    expect(codexTypes).toEqual(["revision_submitted", "request_created"]);
    expect(hub.store.listVisibleEvents(hub.claude.participantId).events).toEqual([]);
    expect(hub.store.listVisibleEvents(hub.gemini.participantId).events).toEqual([]); // not in the thread
  });

  it("hides directed messages from other participants", () => {
    const t = openReview({ reviewers: [hub.codex.participantId, hub.gemini.participantId] });
    hub.store.post(hub.claude, {
      idempotencyKey: key(),
      threadId: t.thread_id,
      kind: "question",
      body: "Codex only",
      recipients: [hub.codex.participantId],
    });
    const forGemini = hub.store.listVisibleEvents(hub.gemini.participantId).events.filter((e) => e.type === "message_posted");
    const forCodex = hub.store.listVisibleEvents(hub.codex.participantId).events.filter((e) => e.type === "message_posted");
    expect(forGemini).toHaveLength(0);
    expect(forCodex).toHaveLength(1);
  });

  it("keeps the model a message was written with, even after the participant changes model", () => {
    const t = openReview();
    const posted = hub.store.post(hub.codex, { idempotencyKey: key(), threadId: t.thread_id, kind: "comment", body: "hi" });
    hub.store.register({ participantId: hub.codex.participantId, model: "gpt-codex-next" });
    const msg = hub.store.getMessage(posted.message_id);
    expect(msg.sender_model).toBe("gpt-codex");
    expect(hub.store.getParticipant(hub.codex.participantId).default_model).toBe("gpt-codex-next");
  });

  it("paginates events with has_more", () => {
    const t = openReview();
    for (let i = 0; i < 5; i++) {
      hub.store.post(hub.claude, { idempotencyKey: key(), threadId: t.thread_id, kind: "comment", body: `c${i}` });
    }
    const p1 = hub.store.listVisibleEvents(hub.codex.participantId, { limit: 3 });
    expect(p1.events).toHaveLength(3);
    expect(p1.has_more).toBe(true);
    const p2 = hub.store.listVisibleEvents(hub.codex.participantId, { afterSeq: p1.event_cursor, limit: 10 });
    expect(p2.events).toHaveLength(4);
    expect(p2.has_more).toBe(false);
  });
});

describe("session reuse for automatic registration", () => {
  const WINDOW_MS = 10 * 60_000;
  const codexSessions = () =>
    hub.store.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE participant_id = ?").get(hub.codex.participantId);
  const again = (overrides: { model?: string; capabilities?: string[] } = {}) =>
    hub.store.register({
      participantId: hub.codex.participantId,
      client: "codex-cli",
      model: overrides.model ?? "gpt-codex",
      role: "agent",
      capabilities: overrides.capabilities,
      reuseSessionWithinMs: WINDOW_MS,
    }).session;

  it("resumes a recent session whose client, model, role and capabilities all match", () => {
    expect(again().id).toBe(hub.codex.sessionId);
    expect(codexSessions()).toEqual({ n: 1 });
  });

  it("starts a new session when any snapshot field differs", () => {
    expect(again({ model: "gpt-codex-next" }).id).not.toBe(hub.codex.sessionId);
    expect(again({ capabilities: ["run_tests"] }).id).not.toBe(hub.codex.sessionId);
    expect(codexSessions()).toEqual({ n: 3 });
  });

  it("starts a new session when the matching one was last seen outside the window", () => {
    hub.store.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", hub.codex.sessionId);
    expect(again().id).not.toBe(hub.codex.sessionId);
  });

  it("refreshes last_seen_at on the resumed session", () => {
    hub.store.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), hub.codex.sessionId);
    const resumed = again();
    expect(resumed.id).toBe(hub.codex.sessionId);
    expect(Date.parse(resumed.last_seen_at)).toBeGreaterThan(Date.now() - 5_000);
  });

  it("always starts a new session for an explicit register", () => {
    const { session } = hub.store.register({ participantId: hub.codex.participantId, client: "codex-cli", model: "gpt-codex", role: "agent" });
    expect(session.id).not.toBe(hub.codex.sessionId);
  });
});
