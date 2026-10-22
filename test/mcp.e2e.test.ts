import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PATCH_R1, PATCH_R2 } from "./helpers.js";

/**
 * End-to-end acceptance test (spec §9) over real stdio MCP connections: each
 * agent gets its own `collidr serve` process, sharing one database file.
 */

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

let dir: string;
let repo: string;
let db: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "collidr-e2e-"));
  repo = join(dir, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  db = join(dir, "hub.db");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Agent {
  client: Client;
  call<T = any>(name: string, args?: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<T>;
  callRaw(name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; body: any }>;
  close(): Promise<void>;
}

async function connect(participant: string, model: string): Promise<Agent> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "serve"],
    cwd: repo,
    env: {
      ...(process.env as Record<string, string>),
      COLLIDR_DB: db,
      COLLIDR_PARTICIPANT: participant,
      COLLIDR_MODEL: model,
      COLLIDR_WORKSPACE: repo,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: `${participant}-client`, version: "1.0.0" });
  await client.connect(transport);
  const callRaw = async (name: string, args: Record<string, unknown> = {}, opts: { signal?: AbortSignal } = {}) => {
    const res = (await client.callTool({ name, arguments: args }, undefined, { signal: opts.signal, timeout: 60_000 })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };
    return { isError: Boolean(res.isError), body: JSON.parse(res.content[0]!.text) };
  };
  return {
    client,
    callRaw,
    async call(name, args, opts) {
      const r = await callRaw(name, args, opts);
      if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.body)}`);
      return r.body;
    },
    close: () => client.close(),
  };
}

describe("Claude ↔ Codex review over MCP (acceptance, spec §9)", () => {
  it("lists the v1 tool surface", async () => {
    const a = await connect("probe", "none");
    const { tools } = await a.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "ack",
        "inbox",
        "list_threads",
        "open_thread",
        "post",
        "read_revision",
        "read_thread",
        "register",
        "resolve",
        "submit_revision",
        "wait_for_messages",
        "whoami",
      ].sort(),
    );
    const who = await a.call("whoami");
    expect(who.registered).toBe(true);
    expect(who.session.client).toBe("probe-client"); // from the MCP handshake
    expect(who.workspace.repo_root).toBeTruthy();
    await a.close();
  });

  it("runs the full exchange with restarts, retries, a changed diff and clean waits", async () => {
    let claude = await connect("claude-author", "claude-opus-5-5");
    let codex = await connect("codex-reviewer", "gpt-codex");
    await codex.call("whoami"); // registers codex so it can be named as a reviewer

    // A review request alone (no message) wakes Codex's inbox wait.
    const waiting = codex.call("wait_for_messages", { timeout_s: 20 });
    await new Promise((r) => setTimeout(r, 300));
    const opened = await claude.call("open_thread", {
      idempotency_key: "open:fix-sum",
      type: "diff_review",
      title: "Fix sum()",
      reviewers: ["codex-reviewer"],
      content_type: "patch",
      content: PATCH_R1,
      base_commit: "aaa111",
      head_commit: "bbb222",
    });
    const woke = await waiting;
    expect(woke.status).toBe("events");
    const req1 = woke.events.find((e: any) => e.type === "request_created")?.request;
    expect(req1.assignee_id).toBe("codex-reviewer");
    expect(req1.target_revision_id).toBe(opened.revision_id);

    // Codex retrieves the exact stored revision through MCP.
    const rev = await codex.call("read_revision", { thread_id: opened.thread_id, revision_id: opened.revision_id });
    expect(rev.lines.join("\n")).toBe(PATCH_R1);
    expect(rev.revision.content_hash).toMatch(/^[0-9a-f]{64}$/);

    await codex.call("post", {
      idempotency_key: `comment:${opened.thread_id}:negatives`,
      thread_id: opened.thread_id,
      kind: "comment",
      body: "Please cover negative numbers.",
      revision_id: opened.revision_id,
      anchors: [{ path: "src/sum.ts", line_start: 2 }],
    });

    // A question can't complete the request.
    const bad = await codex.callRaw("post", {
      idempotency_key: "question-with-request",
      thread_id: opened.thread_id,
      kind: "question",
      body: "Is subtraction intended?",
      response_request_id: req1.id,
    });
    expect(bad.isError).toBe(true);
    expect(bad.body.error.code).toBe("verdict_required");

    const verdictArgs = {
      idempotency_key: `verdict:${req1.id}`,
      thread_id: opened.thread_id,
      kind: "verdict",
      verdict: "request_changes",
      body: "Needs the negative-number case.",
      response_request_id: req1.id,
    };
    const v1 = await codex.call("post", verdictArgs);
    expect(v1.completed_request_id).toBe(req1.id);

    // Codex crashes before acking; both its server process and its client restart.
    await codex.close();
    codex = await connect("codex-reviewer", "gpt-codex");
    const replay = await codex.call("inbox");
    expect(replay.acked_cursor).toBe(0);
    expect(replay.events.some((e: any) => e.type === "request_created" && e.request.id === req1.id)).toBe(true);
    // Re-handling the replayed request with the same derived key creates nothing new.
    const v1again = await codex.call("post", verdictArgs);
    expect(v1again.message_id).toBe(v1.message_id);
    await codex.call("ack", { scope: "inbox", event_cursor: replay.event_cursor });

    // Claude, waiting on the thread, sees the verdict.
    const claudeSeen = await claude.call("wait_for_messages", { thread_id: opened.thread_id, event_cursor: 0, timeout_s: 5 });
    expect(claudeSeen.events.some((e: any) => e.message?.verdict === "request_changes")).toBe(true);

    // Claude's MCP server restarts (same client config), then submits r2; retry is safe.
    await claude.close();
    claude = await connect("claude-author", "claude-opus-5-5");
    const r2Args = {
      idempotency_key: `rev:${opened.thread_id}:2`,
      thread_id: opened.thread_id,
      content_type: "patch",
      content: PATCH_R2,
    };
    const r2 = await claude.call("submit_revision", r2Args);
    const r2retry = await claude.call("submit_revision", r2Args);
    expect(r2retry).toEqual(r2);
    expect(r2.number).toBe(2);
    expect(r2.superseded_request_ids).toEqual([]); // r1's request was completed, not superseded

    // Same key, different arguments: rejected.
    const conflict = await claude.callRaw("submit_revision", { ...r2Args, content: PATCH_R2 + "\n+// other" });
    expect(conflict.body.error.code).toBe("idempotency_conflict");

    const state = await claude.call("read_thread", { thread_id: opened.thread_id });
    expect(state.latest_revision.number).toBe(2);
    expect(state.awaiting).toEqual(["codex-reviewer"]);

    // Codex picks up the new request from its saved cursor and approves r2.
    const inbox2 = await codex.call("inbox");
    const req2 = inbox2.events.find((e: any) => e.type === "request_created")?.request;
    expect(req2.target_revision_id).toBe(r2.revision_id);
    await codex.call("post", {
      idempotency_key: `verdict:${req2.id}`,
      thread_id: opened.thread_id,
      kind: "verdict",
      verdict: "approve",
      body: "LGTM.",
      response_request_id: req2.id,
    });
    await codex.call("ack", { scope: "inbox", event_cursor: inbox2.event_cursor });

    // Resolving against the stale r1 fails; against r2 it succeeds.
    const stale = await claude.callRaw("resolve", {
      idempotency_key: "resolve:stale",
      thread_id: opened.thread_id,
      expected_revision_id: opened.revision_id,
      outcome: "resolved",
      summary: "done",
    });
    expect(stale.body.error.code).toBe("stale_revision");
    const resolved = await claude.call("resolve", {
      idempotency_key: `resolve:${opened.thread_id}`,
      thread_id: opened.thread_id,
      expected_revision_id: r2.revision_id,
      outcome: "resolved",
      summary: "Fixed sum() and covered negatives; approved by Codex.",
    });
    expect(resolved.resolved_revision_id).toBe(r2.revision_id);

    // A closed thread rejects further posts.
    const late = await codex.callRaw("post", {
      idempotency_key: "late",
      thread_id: opened.thread_id,
      kind: "comment",
      body: "one more thing",
    });
    expect(late.body.error.code).toBe("thread_closed");

    // Codex sees the thread close, acks it, and then has nothing pending.
    const closing = await codex.call("inbox");
    expect(closing.events.some((e: any) => e.type === "thread_closed" && e.resolution.outcome === "resolved")).toBe(true);
    await codex.call("ack", { scope: "inbox", event_cursor: closing.event_cursor });

    // A wait with nothing new returns a clean timeout well inside client limits.
    const t0 = Date.now();
    const idle = await codex.call("wait_for_messages", { timeout_s: 1 });
    expect(idle.status).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(5000);

    await claude.close();
    await codex.close();
  });

  it("runs a plan review that auto-resolves on its final round", async () => {
    const author = await connect("planner", "gemini-pro");
    const reviewer = await connect("skeptic", "grok");
    await reviewer.call("whoami");
    const plan = "1. Add events table\n2. Add cursors\n3. Ship";
    const t = await author.call("open_thread", {
      idempotency_key: "open:plan",
      type: "plan_review",
      title: "v1 plan",
      reviewers: ["skeptic"],
      round_limit: 1,
      content_type: "plan",
      content: plan,
    });
    const limit = await author.callRaw("submit_revision", {
      idempotency_key: "rev:plan:2",
      thread_id: t.thread_id,
      content_type: "plan",
      content: plan + "\n4. Celebrate",
    });
    expect(limit.body.error.code).toBe("round_limit_reached");

    const inbox = await reviewer.call("inbox");
    const req = inbox.events.find((e: any) => e.type === "request_created").request;
    const page = await reviewer.call("read_revision", { thread_id: t.thread_id, revision_id: req.target_revision_id });
    expect(page.revision.content_type).toBe("plan");
    const done = await reviewer.call("post", {
      idempotency_key: `verdict:${req.id}`,
      thread_id: t.thread_id,
      kind: "verdict",
      verdict: "approve",
      body: "Sound plan.",
      response_request_id: req.id,
    });
    expect(done.thread_status).toBe("resolved");
    const state = await author.call("read_thread", { thread_id: t.thread_id });
    expect(state.resolution.resolved_by).toBeNull();
    await author.close();
    await reviewer.close();
  });

  it("cancels a wait cleanly and keeps the server responsive", async () => {
    const a = await connect("canceller", "none");
    const ctl = new AbortController();
    const pending = a.call("wait_for_messages", { timeout_s: 30 }, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 300);
    await expect(pending).rejects.toThrow();
    const t0 = Date.now();
    const who = await a.call("whoami");
    expect(who.registered).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
    await a.close();
  });

  it.each(["inbox", "wait_for_messages"])("%s acknowledges only the selected workspace across restarts", async (tool) => {
    const author = await connect(`scoped-author-${tool}`, "none");
    let reviewer = await connect(`scoped-reviewer-${tool}`, "none");
    const otherRepo = join(dir, `other-${tool}`);
    mkdirSync(join(otherRepo, ".git"), { recursive: true });
    try {
      await reviewer.call("whoami");
      const open = (workspace: string, label: string) => author.call("open_thread", {
        workspace,
        idempotency_key: `open:${label}`,
        type: "plan_review",
        title: label,
        reviewers: [`scoped-reviewer-${tool}`],
        content_type: "plan",
        content: "Review this plan",
      });
      const older = await open(otherRepo, "older");
      const newer = await open(repo, "newer");
      const args = tool === "wait_for_messages" ? { timeout_s: 0 } : {};
      const page = await reviewer.call(tool, { workspace: repo, ...args });
      expect(page.events.map((e: any) => e.thread_id)).toEqual([newer.thread_id, newer.thread_id]);

      // The fallback exercises the old protocol too: its global ack loses the older request.
      await reviewer.call("ack", { scope: page.ack_scope ?? "inbox", event_cursor: page.event_cursor });
      const other = await reviewer.call(tool, { workspace: otherRepo, ...args });
      expect(other.events.map((e: any) => e.thread_id)).toEqual([older.thread_id, older.thread_id]);
      expect(page.ack_scope).toBe(`workspace:${page.events[0].workspace_id}`);
      expect(other.ack_scope).toBe(`workspace:${other.events[0].workspace_id}`);

      // A stale acknowledgment cannot move this workspace's saved cursor backward.
      const stale = await reviewer.call("ack", { scope: page.ack_scope, event_cursor: page.events[0].seq });
      expect(stale.acked_cursor).toBe(page.event_cursor);
      await reviewer.close();
      reviewer = await connect(`scoped-reviewer-${tool}`, "none");
      const resumed = await reviewer.call("inbox", { workspace: page.events[0].workspace_id });
      expect(resumed.events).toEqual([]);
      expect(resumed.acked_cursor).toBe(page.event_cursor);
      expect(resumed.ack_scope).toBe(page.ack_scope);
      const idle = await reviewer.call("wait_for_messages", { workspace: repo, timeout_s: 0 });
      expect(idle.status).toBe("timeout");
      expect(idle.ack_scope).toBe(page.ack_scope);
      const pending = await reviewer.call("wait_for_messages", { workspace: otherRepo, timeout_s: 0 });
      expect(pending.status).toBe("events");
      expect(pending.events.map((e: any) => e.thread_id)).toEqual([older.thread_id, older.thread_id]);

      const global = await reviewer.call("inbox");
      expect(global.ack_scope).toBe("inbox");
      expect(global.acked_cursor).toBe(0);
      expect(global.events.some((e: any) => e.thread_id === older.thread_id)).toBe(true);
      await reviewer.call("ack", { scope: global.ack_scope, event_cursor: global.event_cursor });
      const scopedAfterGlobalAck = await reviewer.call("inbox", { workspace: otherRepo });
      expect(scopedAfterGlobalAck.events.map((e: any) => e.thread_id)).toEqual([older.thread_id, older.thread_id]);
      const replay = await reviewer.call("inbox", { workspace: repo, event_cursor: 0, limit: 1 });
      expect(replay.events).toHaveLength(1);
      expect(replay.has_more).toBe(true);
      const next = await reviewer.call("inbox", { workspace: repo, event_cursor: replay.event_cursor });
      expect(next.events.map((e: any) => e.type)).toEqual(["request_created"]);
      expect(next.has_more).toBe(false);
    } finally {
      await reviewer.close();
      await author.close();
    }
  });

  it("keeps thread acknowledgments independent when a wait also specifies a workspace", async () => {
    const author = await connect("thread-scope-author", "none");
    const reviewer = await connect("thread-scope-reviewer", "none");
    try {
      await reviewer.call("whoami");
      const opened = await author.call("open_thread", {
        idempotency_key: "open:thread-scope",
        type: "plan_review",
        title: "Thread scope",
        reviewers: ["thread-scope-reviewer"],
        content_type: "plan",
        content: "Review this plan",
      });
      const waiting = await reviewer.call("wait_for_messages", { thread_id: opened.thread_id, workspace: repo, timeout_s: 0 });
      expect(waiting.ack_scope).toBe(`thread:${opened.thread_id}`);
      // Keep accepting the existing bare-thread-ID form as well as canonical scopes.
      await reviewer.call("ack", { scope: opened.thread_id, event_cursor: waiting.event_cursor });
      const idle = await reviewer.call("wait_for_messages", { thread_id: opened.thread_id, timeout_s: 0 });
      expect(idle.status).toBe("timeout");
      expect(idle.ack_scope).toBe(waiting.ack_scope);
      const history = await reviewer.call("read_thread", { thread_id: opened.thread_id });
      expect(history.ack_scope).toBe(waiting.ack_scope);
      const inbox = await reviewer.call("inbox", { workspace: repo });
      expect(inbox.events).toHaveLength(2);
      expect(inbox.acked_cursor).toBe(0);
    } finally {
      await reviewer.close();
      await author.close();
    }
  });
});
