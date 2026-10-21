import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { CollidrError, isCollidrError } from "./errors.js";
import type { Store } from "./store.js";
import type { Actor } from "./types.js";
import { resolveWorkspace } from "./workspace.js";
import { VERSION } from "./version.js";

export const DEFAULT_WAIT_S = 25;
export const POLL_INTERVAL_MS = 250;

export interface ServerOptions {
  /** Participant to resume at startup (normally from COLLIDR_PARTICIPANT). */
  participantId?: string;
  displayName?: string;
  client?: string;
  model?: string;
  role?: string;
  capabilities?: string[];
  /** Working directory used for workspace resolution. */
  cwd?: string;
  /** Upper bound for wait_for_messages, in seconds. */
  maxWaitS?: number;
  pollIntervalMs?: number;
}

const INSTRUCTIONS = `Collidr is a shared coordination hub. Other AI agents (and the human) read and write the same threads.

Protocol essentials:
- You have a stable participant ID (see whoami). Call register only if whoami says you are not registered.
- Every write takes an idempotency_key. Derive it from the logical action, never randomly, so a retry after a crash or restart reuses it. Good keys: "verdict:<request_id>", "rev:<thread_id>:<n>", "comment:<thread_id>:<short-topic>". When completing a review request, use "verdict:<request_id>".
- To find work: call inbox (it resumes from your saved cursor). Review requests assigned to you appear as request_created events.
- To review: read_revision to get the exact content, post comments (anchors are relative to that revision), then post kind="verdict" with verdict="approve" or "request_changes" and response_request_id. Only verdicts complete a review request.
- After you have handled events, call ack with the returned event_cursor. Unacked events are delivered again after a restart.
- To wait for others: wait_for_messages. It returns status "timeout" after about ${DEFAULT_WAIT_S}s with no news; call it again if you still want to wait.
- Posting a message does not wake another agent. If someone needs to act, they must be waiting or check their inbox.
- An approve verdict is a review result only, never permission to merge or deploy.`;

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): CallToolResult {
  const body = isCollidrError(err)
    ? { error: err.toJSON() }
    : { error: { code: "internal_error", message: err instanceof Error ? err.message : String(err) } };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

// Shared schema fragments ---------------------------------------------------

const idempotencyKey = z
  .string()
  .min(1)
  .max(200)
  .describe("Derived from the logical action (not random), so retries after a crash reuse it.");
const workspaceArg = z
  .string()
  .optional()
  .describe("Workspace ID or a path inside the repository. Defaults to COLLIDR_WORKSPACE or the server's git root.");
const contentType = z.enum(["patch", "snapshot", "plan"]);
const eventCursor = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("Return events after this sequence number. Omit to resume from your saved (acked) cursor.");
const limit = z.number().int().min(1).max(200).optional();

export function createServer(store: Store, opts: ServerOptions = {}): { server: McpServer; actor: () => Actor | null } {
  const server = new McpServer({ name: "collidr", version: VERSION }, { instructions: INSTRUCTIONS });
  let actor: Actor | null = null;
  const cwd = opts.cwd ?? process.cwd();
  const maxWaitS = opts.maxWaitS ?? 50;
  const pollMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;

  const clientName = () => server.server.getClientVersion()?.name;

  const doRegister = (input: {
    participantId?: string;
    displayName?: string;
    client?: string;
    model?: string;
    role?: string;
    capabilities?: string[];
  }) => {
    const participantId = input.participantId ?? opts.participantId;
    if (!participantId) {
      throw new CollidrError(
        "invalid_argument",
        "no participant ID: pass participant_id, or set COLLIDR_PARTICIPANT in this server's MCP config",
      );
    }
    const res = store.register({
      participantId,
      displayName: input.displayName ?? opts.displayName,
      client: input.client ?? opts.client ?? clientName(),
      model: input.model ?? opts.model,
      role: input.role ?? opts.role,
      capabilities: input.capabilities ?? opts.capabilities,
    });
    actor = { participantId: res.participant.id, sessionId: res.session.id };
    return res;
  };

  // Resume lazily on the first tool call when configured, so the session can
  // record the connecting client's name from the MCP handshake.
  const me = (): Actor => {
    if (!actor && opts.participantId) doRegister({});
    if (!actor) {
      throw new CollidrError(
        "invalid_argument",
        "not registered yet: call register (or set COLLIDR_PARTICIPANT in the MCP server config)",
      );
    }
    return actor;
  };

  const handle =
    <A>(fn: (args: A, signal?: AbortSignal) => unknown | Promise<unknown>) =>
    async (args: A, extra: { signal?: AbortSignal }): Promise<CallToolResult> => {
      try {
        return ok(await fn(args, extra.signal));
      } catch (err) {
        return fail(err);
      }
    };

  // ---------------------------------------------------------------- identity

  server.registerTool(
    "register",
    {
      description:
        "Start a new session as a participant, recording the client, model and capabilities for this run. Usually automatic via COLLIDR_PARTICIPANT; call it to set your model or capabilities, or if whoami says you are not registered.",
      inputSchema: {
        participant_id: z.string().optional().describe("Stable ID such as 'codex-reviewer'. Defaults to COLLIDR_PARTICIPANT."),
        display_name: z.string().optional(),
        client: z.string().optional().describe("e.g. claude-code, codex-cli, gemini-cli"),
        model: z.string().optional(),
        role: z.string().optional().describe("e.g. author, reviewer, planner"),
        capabilities: z
          .array(z.string())
          .optional()
          .describe("What you can actually do, e.g. read_patch, inspect_repo, run_tests. Declarations, not evidence."),
      },
    },
    handle((a: {
      participant_id?: string;
      display_name?: string;
      client?: string;
      model?: string;
      role?: string;
      capabilities?: string[];
    }) => {
      const res = doRegister({
        participantId: a.participant_id,
        displayName: a.display_name,
        client: a.client,
        model: a.model,
        role: a.role,
        capabilities: a.capabilities,
      });
      return { participant: res.participant, session: res.session, cursors: res.cursors };
    }),
  );

  server.registerTool(
    "whoami",
    { description: "Your participant, current session, saved cursors and the default workspace.", inputSchema: {} },
    handle(() => {
      if (!actor && opts.participantId) me();
      if (!actor) return { registered: false, hint: "call register" };
      let workspace: unknown = null;
      try {
        workspace = resolveWorkspace(store, undefined, cwd);
      } catch (err) {
        workspace = isCollidrError(err) ? { error: err.toJSON() } : null;
      }
      return {
        registered: true,
        participant: store.getParticipant(actor.participantId),
        session: store.getSession(actor.sessionId),
        cursors: store.getCursors(actor.participantId),
        workspace,
      };
    }),
  );

  // ---------------------------------------------------------------- threads

  server.registerTool(
    "list_threads",
    {
      description: "List threads in a workspace, oldest first. Paginate with after_thread_id.",
      inputSchema: {
        workspace: workspaceArg,
        status: z.enum(["open", "resolved", "unresolved"]).optional(),
        mine_only: z.boolean().optional().describe("Only threads you participate in."),
        after_thread_id: z.string().optional(),
        limit,
      },
    },
    handle((a: { workspace?: string; status?: "open" | "resolved" | "unresolved"; mine_only?: boolean; after_thread_id?: string; limit?: number }) => {
      const ws = resolveWorkspace(store, a.workspace, cwd);
      return {
        workspace: ws,
        ...store.listThreads(ws.id, {
          status: a.status,
          participantId: a.mine_only ? me().participantId : undefined,
          afterId: a.after_thread_id,
          limit: a.limit,
        }),
      };
    }),
  );

  server.registerTool(
    "open_thread",
    {
      description:
        "Start a diff or plan review. Creates revision r1 and one review request per reviewer in a single transaction. You become the thread's author.",
      inputSchema: {
        idempotency_key: idempotencyKey,
        workspace: workspaceArg,
        type: z.enum(["diff_review", "plan_review"]),
        title: z.string().min(1),
        reviewers: z.array(z.string()).min(1).describe("Participant IDs that must review r1."),
        observers: z.array(z.string()).optional().describe("Extra participants who can read and comment but are not required reviewers."),
        round_limit: z.number().int().min(1).max(20).optional().describe("Default 3."),
        content_type: contentType,
        content: z.string().min(1).describe("The patch, snapshot or plan text being reviewed (max 2 MB)."),
        base_commit: z.string().optional(),
        head_commit: z.string().optional(),
      },
    },
    handle((a: {
      idempotency_key: string;
      workspace?: string;
      type: "diff_review" | "plan_review";
      title: string;
      reviewers: string[];
      observers?: string[];
      round_limit?: number;
      content_type: "patch" | "snapshot" | "plan";
      content: string;
      base_commit?: string;
      head_commit?: string;
    }) => {
      const ws = resolveWorkspace(store, a.workspace, cwd);
      return store.openThread(me(), {
        idempotencyKey: a.idempotency_key,
        workspaceId: ws.id,
        type: a.type,
        title: a.title,
        reviewers: a.reviewers,
        participants: (a.observers ?? []).map((p) => ({ participantId: p, role: "observer" })),
        roundLimit: a.round_limit,
        contentType: a.content_type,
        content: a.content,
        baseCommit: a.base_commit,
        headCommit: a.head_commit,
        repoIdentity: ws.repo_remote ?? ws.repo_root,
      });
    }),
  );

  server.registerTool(
    "submit_revision",
    {
      description:
        "Author only. Add a new immutable revision and start the next round. Re-requests the previous round's reviewers unless you pass reviewers. Still-open requests on older revisions become superseded. Fails with round_limit_reached on the final round.",
      inputSchema: {
        idempotency_key: idempotencyKey,
        thread_id: z.string(),
        content_type: contentType,
        content: z.string().min(1),
        reviewers: z.array(z.string()).min(1).optional(),
        base_commit: z.string().optional(),
        head_commit: z.string().optional(),
      },
    },
    handle((a: {
      idempotency_key: string;
      thread_id: string;
      content_type: "patch" | "snapshot" | "plan";
      content: string;
      reviewers?: string[];
      base_commit?: string;
      head_commit?: string;
    }) => {
      const thread = store.getThread(a.thread_id);
      const ws = store.getWorkspace(thread.workspace_id);
      return store.submitRevision(me(), {
        idempotencyKey: a.idempotency_key,
        threadId: a.thread_id,
        contentType: a.content_type,
        content: a.content,
        reviewers: a.reviewers,
        baseCommit: a.base_commit,
        headCommit: a.head_commit,
        repoIdentity: ws.repo_remote ?? ws.repo_root,
      });
    }),
  );

  server.registerTool(
    "read_revision",
    {
      description:
        "Read a revision's exact stored content (with its content hash and commit metadata), paginated by lines. content_cursor is independent of event cursors; reading never acknowledges anything.",
      inputSchema: {
        thread_id: z.string(),
        revision_id: z.string(),
        content_cursor: z.number().int().min(0).optional().describe("0-based line offset; use the content_cursor from the previous page."),
        limit: z.number().int().min(1).max(2000).optional().describe("Lines per page, default 400."),
      },
    },
    handle((a: { thread_id: string; revision_id: string; content_cursor?: number; limit?: number }) =>
      store.readRevision(me().participantId, a.thread_id, a.revision_id, {
        contentCursor: a.content_cursor,
        limit: a.limit,
      }),
    ),
  );

  server.registerTool(
    "post",
    {
      description:
        "Post to a thread. Kinds: comment, question, proposal, objection, verdict. Only kind='verdict' (with verdict and response_request_id) completes a review request. Anchors are relative to revision_id.",
      inputSchema: {
        idempotency_key: idempotencyKey,
        thread_id: z.string(),
        kind: z.enum(["comment", "question", "proposal", "objection", "verdict"]),
        body: z.string().min(1),
        verdict: z.enum(["approve", "request_changes"]).optional(),
        response_request_id: z.string().optional().describe("The review request this verdict completes."),
        revision_id: z.string().optional(),
        anchors: z
          .array(z.object({ path: z.string(), line_start: z.number().int().min(1), line_end: z.number().int().min(1).optional() }))
          .optional(),
        reply_to: z.string().optional(),
        recipients: z.array(z.string()).optional().describe("Direct the message to these participants only."),
        evidence: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("What you actually executed (command, exit code, output hash). Self-reported."),
      },
    },
    handle((a: {
      idempotency_key: string;
      thread_id: string;
      kind: "comment" | "question" | "proposal" | "objection" | "verdict";
      body: string;
      verdict?: "approve" | "request_changes";
      response_request_id?: string;
      revision_id?: string;
      anchors?: { path: string; line_start: number; line_end?: number }[];
      reply_to?: string;
      recipients?: string[];
      evidence?: Record<string, unknown>;
    }) =>
      store.post(me(), {
        idempotencyKey: a.idempotency_key,
        threadId: a.thread_id,
        kind: a.kind,
        body: a.body,
        verdict: a.verdict,
        responseRequestId: a.response_request_id,
        revisionId: a.revision_id,
        anchors: a.anchors,
        replyTo: a.reply_to,
        recipients: a.recipients,
        evidence: a.evidence,
      }),
    ),
  );

  server.registerTool(
    "read_thread",
    {
      description:
        "A thread's current state (round, latest revision, open requests, resolution) plus its event history including your own posts, paginated by event_cursor.",
      inputSchema: {
        thread_id: z.string(),
        event_cursor: z.number().int().min(0).optional().describe("Return events after this sequence number; default 0 (from the start)."),
        limit,
      },
    },
    handle((a: { thread_id: string; event_cursor?: number; limit?: number }) => {
      const pid = me().participantId;
      const summary = store.threadSummary(a.thread_id);
      if (!summary.participants.some((p) => p.participant_id === pid)) {
        throw new CollidrError("not_participant", `${pid} is not a participant in this thread`);
      }
      return {
        ...summary,
        ...store.listVisibleEvents(pid, {
          threadId: a.thread_id,
          afterSeq: a.event_cursor ?? 0,
          limit: a.limit,
          includeOwn: true,
        }),
      };
    }),
  );

  server.registerTool(
    "inbox",
    {
      description:
        "Events for you across your threads: messages to you, review requests assigned to you, and lifecycle events (request completed/superseded/cancelled, revision submitted, thread closed). Excludes your own actions. Resumes from your saved inbox cursor unless event_cursor is given. Call ack when done.",
      inputSchema: { workspace: z.string().optional().describe("Limit to one workspace (ID or path)."), event_cursor: eventCursor, limit },
    },
    handle((a: { workspace?: string; event_cursor?: number; limit?: number }) => {
      const pid = me().participantId;
      const workspaceId = a.workspace ? resolveWorkspace(store, a.workspace, cwd).id : undefined;
      const after = a.event_cursor ?? store.getCursors(pid).inbox ?? 0;
      return { ...store.listVisibleEvents(pid, { afterSeq: after, workspaceId, limit: a.limit }), acked_cursor: store.getCursors(pid).inbox ?? 0 };
    }),
  );

  server.registerTool(
    "wait_for_messages",
    {
      description: `Block until there is a new event for you (in your inbox, or in one thread), or until the timeout (default ${DEFAULT_WAIT_S}s). Returns status "events" or "timeout"; on timeout just call again if you still want to wait.`,
      inputSchema: {
        thread_id: z.string().optional().describe("Wait on one thread instead of your whole inbox."),
        workspace: z.string().optional(),
        event_cursor: eventCursor,
        timeout_s: z.number().min(0).max(600).optional(),
      },
    },
    handle(async (a: { thread_id?: string; workspace?: string; event_cursor?: number; timeout_s?: number }, signal) => {
      const pid = me().participantId;
      const workspaceId = a.workspace ? resolveWorkspace(store, a.workspace, cwd).id : undefined;
      const cursors = store.getCursors(pid);
      const after =
        a.event_cursor ?? (a.thread_id ? (cursors[`thread:${a.thread_id}`] ?? 0) : (cursors.inbox ?? 0));
      const timeoutMs = Math.min(a.timeout_s ?? DEFAULT_WAIT_S, maxWaitS) * 1000;
      const deadline = Date.now() + timeoutMs;
      // Poll durable state: separate stdio processes can't share in-memory notifications.
      for (;;) {
        const page = store.listVisibleEvents(pid, { afterSeq: after, threadId: a.thread_id, workspaceId });
        if (page.events.length > 0) return { status: "events", ...page };
        if (signal?.aborted) return { status: "cancelled", events: [], event_cursor: after, has_more: false };
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { status: "timeout", events: [], event_cursor: after, has_more: false };
        await sleep(Math.min(pollMs, remaining), signal);
      }
    }),
  );

  server.registerTool(
    "ack",
    {
      description:
        "Save your resume point after handling events. scope is 'inbox' or a thread ID. Cursors never move backward; sessions of the same participant share them.",
      inputSchema: {
        scope: z.string().describe("'inbox' or a thread_id"),
        event_cursor: z.number().int().min(0),
      },
    },
    handle((a: { scope: string; event_cursor: number }) => {
      const scope = a.scope === "inbox" ? "inbox" : `thread:${a.scope.replace(/^thread:/, "")}`;
      return { scope, acked_cursor: store.ack(me().participantId, scope, a.event_cursor) };
    }),
  );

  server.registerTool(
    "resolve",
    {
      description:
        "Author only. Close an open thread with an outcome record. expected_revision_id must be the latest revision, or this fails with stale_revision.",
      inputSchema: {
        idempotency_key: idempotencyKey,
        thread_id: z.string(),
        expected_revision_id: z.string(),
        outcome: z.enum(["resolved", "unresolved"]),
        summary: z.string().min(1),
        evidence: z.record(z.string(), z.unknown()).optional(),
        outstanding_objections: z
          .array(z.object({ reviewer_id: z.string(), message_id: z.string(), body: z.string() }))
          .optional(),
      },
    },
    handle((a: {
      idempotency_key: string;
      thread_id: string;
      expected_revision_id: string;
      outcome: "resolved" | "unresolved";
      summary: string;
      evidence?: Record<string, unknown>;
      outstanding_objections?: { reviewer_id: string; message_id: string; body: string }[];
    }) =>
      store.resolve(me(), {
        idempotencyKey: a.idempotency_key,
        threadId: a.thread_id,
        expectedRevisionId: a.expected_revision_id,
        outcome: a.outcome,
        summary: a.summary,
        evidence: a.evidence,
        outstandingObjections: a.outstanding_objections,
      }),
    ),
  );

  return { server, actor: () => actor };
}
