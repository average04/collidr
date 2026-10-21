import { createHash } from "node:crypto";
import { ulid } from "ulid";
import type { DB } from "./db.js";
import { CollidrError } from "./errors.js";
import type {
  Actor,
  Anchor,
  ContentType,
  EventType,
  HubEvent,
  Message,
  MessageKind,
  Objection,
  Participant,
  RequestStatus,
  Resolution,
  ResponseRequest,
  RevisionMeta,
  Session,
  Thread,
  ThreadType,
  Verdict,
  Workspace,
} from "./types.js";

/** Revision content cap (spec §6). */
export const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
/** Message body cap; keeps single responses bounded. */
export const MAX_BODY_BYTES = 64 * 1024;
export const DEFAULT_ROUND_LIMIT = 3;
export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;
export const DEFAULT_CONTENT_LINES = 400;
export const MAX_CONTENT_LINES = 2000;

const THREAD_TYPES: readonly ThreadType[] = ["diff_review", "plan_review"];
const CONTENT_TYPES: readonly ContentType[] = ["patch", "snapshot", "plan"];
const MESSAGE_KINDS: readonly MessageKind[] = ["comment", "question", "proposal", "objection", "verdict"];
const VERDICTS: readonly Verdict[] = ["approve", "request_changes"];

// ---------------------------------------------------------------- helpers

function now(): string {
  return new Date().toISOString();
}

/** JSON with sorted keys and undefined dropped, so equal arguments fingerprint equally. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function parseJson<T>(text: string | null): T | null {
  return text === null ? null : (JSON.parse(text) as T);
}

function clampLimit(limit: number | undefined, def: number, max: number): number {
  if (limit === undefined) return def;
  if (!Number.isInteger(limit) || limit < 1) throw new CollidrError("invalid_argument", "limit must be a positive integer");
  return Math.min(limit, max);
}

function requireNonEmpty(value: string | undefined, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CollidrError("invalid_argument", `${name} is required`);
  }
  return value;
}

// ---------------------------------------------------------------- row shapes

interface SessionRow extends Omit<Session, "capabilities"> {
  capabilities: string;
}
interface MessageRow
  extends Omit<Message, "recipients" | "anchors" | "evidence" | "sender_client" | "sender_model"> {
  recipients: string | null;
  anchors: string | null;
  evidence: string | null;
  sender_client: string | null;
  sender_model: string | null;
}
interface EventRow extends Omit<HubEvent, "recipients" | "message" | "request" | "revision" | "resolution"> {
  recipients: string | null;
}
interface ResolutionRow extends Omit<Resolution, "evidence" | "outstanding_objections"> {
  evidence: string | null;
  outstanding_objections: string;
}

const REVISION_META_COLUMNS =
  "id, thread_id, number, round, content_type, content_size, content_hash, repo_identity, base_commit, head_commit, created_by, created_at";

// ---------------------------------------------------------------- inputs

export interface RegisterInput {
  participantId: string;
  displayName?: string;
  client?: string;
  model?: string;
  role?: string;
  capabilities?: string[];
}

export interface RevisionInput {
  contentType: ContentType;
  content: string;
  baseCommit?: string;
  headCommit?: string;
  repoIdentity?: string;
}

export interface OpenThreadInput extends RevisionInput {
  idempotencyKey: string;
  workspaceId: string;
  type: ThreadType;
  title: string;
  reviewers: string[];
  /** Extra non-reviewing participants (e.g. observers). */
  participants?: { participantId: string; role: string }[];
  roundLimit?: number;
}

export interface SubmitRevisionInput extends RevisionInput {
  idempotencyKey: string;
  threadId: string;
  /** Defaults to the previous round's reviewers. */
  reviewers?: string[];
}

export interface PostInput {
  idempotencyKey: string;
  threadId: string;
  kind: MessageKind;
  body: string;
  replyTo?: string;
  recipients?: string[];
  revisionId?: string;
  anchors?: Anchor[];
  verdict?: Verdict;
  responseRequestId?: string;
  evidence?: unknown;
}

export interface ResolveInput {
  idempotencyKey: string;
  threadId: string;
  expectedRevisionId: string;
  outcome: "resolved" | "unresolved";
  summary: string;
  evidence?: unknown;
  outstandingObjections?: Objection[];
}

export interface OpenThreadResult {
  thread_id: string;
  revision_id: string;
  request_ids: string[];
}
export interface SubmitRevisionResult {
  revision_id: string;
  number: number;
  round: number;
  request_ids: string[];
  superseded_request_ids: string[];
}
export interface PostResult {
  message_id: string;
  completed_request_id: string | null;
  thread_status: Thread["status"];
}
export interface ResolveResult {
  thread_id: string;
  outcome: "resolved" | "unresolved";
  resolved_revision_id: string;
}

export interface ThreadSummary {
  thread: Thread;
  participants: { participant_id: string; role: string }[];
  latest_revision: RevisionMeta;
  current_round_requests: ResponseRequest[];
  /** Derived display hint: assignees of open requests (spec §5). */
  awaiting: string[];
  resolution: Resolution | null;
}

export interface EventPage {
  events: HubEvent[];
  /** Pass back as `afterSeq` to continue. Equals the input when nothing new. */
  event_cursor: number;
  has_more: boolean;
}

export interface RevisionPage {
  revision: RevisionMeta;
  /** 0-based line offset of the first returned line. */
  start_line: number;
  lines: string[];
  total_lines: number;
  /** Pass back as `contentCursor` for the next page; null at the end. */
  content_cursor: number | null;
}

// ---------------------------------------------------------------- store

export class Store {
  constructor(readonly db: DB) {}

  // ------------------------------------------------------------ idempotency

  /**
   * Run a mutation exactly once per (participant, key). The record is written in
   * the same IMMEDIATE transaction as the mutation's effects, so a lost response
   * or a concurrent retry always returns the original result (spec §5).
   */
  private idempotent<T>(
    actor: Actor,
    key: string,
    operation: string,
    args: unknown,
    fn: () => T,
  ): T {
    requireNonEmpty(key, "idempotency_key");
    const fingerprint = sha256(canonicalJson(args));
    return this.db
      .transaction((): T => {
        const existing = this.db
          .prepare(
            "SELECT operation, args_fingerprint, result FROM idempotency_records WHERE participant_id = ? AND key = ?",
          )
          .get(actor.participantId, key) as
          | { operation: string; args_fingerprint: string; result: string }
          | undefined;
        if (existing) {
          if (existing.operation !== operation || existing.args_fingerprint !== fingerprint) {
            throw new CollidrError(
              "idempotency_conflict",
              `idempotency key "${key}" was already used for a different ${existing.operation} call`,
              { key, original_operation: existing.operation },
            );
          }
          return JSON.parse(existing.result) as T;
        }
        this.touchSession(actor);
        const result = fn();
        this.db
          .prepare(
            "INSERT INTO idempotency_records (participant_id, key, operation, args_fingerprint, result, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(actor.participantId, key, operation, fingerprint, JSON.stringify(result), now());
        return result;
      })
      .immediate();
  }

  // ------------------------------------------------------------ workspaces

  ensureWorkspace(repoRoot: string, repoRemote?: string): Workspace {
    requireNonEmpty(repoRoot, "repo_root");
    return this.db
      .transaction((): Workspace => {
        const found = this.db.prepare("SELECT * FROM workspaces WHERE repo_root = ?").get(repoRoot) as
          | Workspace
          | undefined;
        if (found) {
          if (repoRemote && found.repo_remote !== repoRemote) {
            this.db.prepare("UPDATE workspaces SET repo_remote = ? WHERE id = ?").run(repoRemote, found.id);
            return { ...found, repo_remote: repoRemote };
          }
          return found;
        }
        const ws: Workspace = { id: ulid(), repo_root: repoRoot, repo_remote: repoRemote ?? null, created_at: now() };
        this.db
          .prepare("INSERT INTO workspaces (id, repo_root, repo_remote, created_at) VALUES (?, ?, ?, ?)")
          .run(ws.id, ws.repo_root, ws.repo_remote, ws.created_at);
        return ws;
      })
      .immediate();
  }

  getWorkspace(id: string): Workspace {
    const ws = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as Workspace | undefined;
    if (!ws) throw new CollidrError("not_found", `workspace ${id} not found`);
    return ws;
  }

  // ------------------------------------------------------------ participants

  /**
   * Resume (or create) a participant and start a new session that snapshots the
   * client, model and capabilities for this run (spec §3, §5).
   */
  register(input: RegisterInput): { participant: Participant; session: Session; cursors: Record<string, number> } {
    const id = requireNonEmpty(input.participantId, "participant_id");
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(id)) {
      throw new CollidrError("invalid_argument", "participant_id may only contain letters, digits, '.', '_', ':' and '-'");
    }
    const capabilities = input.capabilities ?? [];
    return this.db
      .transaction(() => {
        const t = now();
        const existing = this.db.prepare("SELECT * FROM participants WHERE id = ?").get(id) as Participant | undefined;
        if (existing) {
          this.db
            .prepare(
              `UPDATE participants SET
                 display_name = COALESCE(?, display_name),
                 default_client = COALESCE(?, default_client),
                 default_model = COALESCE(?, default_model),
                 default_role = COALESCE(?, default_role),
                 updated_at = ?
               WHERE id = ?`,
            )
            .run(input.displayName ?? null, input.client ?? null, input.model ?? null, input.role ?? null, t, id);
        } else {
          this.db
            .prepare(
              "INSERT INTO participants (id, display_name, default_client, default_model, default_role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .run(id, input.displayName ?? id, input.client ?? null, input.model ?? null, input.role ?? null, t, t);
        }
        const session: Session = {
          id: ulid(),
          participant_id: id,
          client: input.client ?? null,
          model: input.model ?? null,
          role: input.role ?? null,
          capabilities,
          started_at: t,
          last_seen_at: t,
        };
        this.db
          .prepare(
            "INSERT INTO sessions (id, participant_id, client, model, role, capabilities, started_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(session.id, id, session.client, session.model, session.role, JSON.stringify(capabilities), t, t);
        return { participant: this.getParticipant(id), session, cursors: this.getCursors(id) };
      })
      .immediate();
  }

  getParticipant(id: string): Participant {
    const p = this.db.prepare("SELECT * FROM participants WHERE id = ?").get(id) as Participant | undefined;
    if (!p) throw new CollidrError("not_found", `participant ${id} is not registered`);
    return p;
  }

  getSession(id: string): Session {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!row) throw new CollidrError("not_found", `session ${id} not found`);
    return { ...row, capabilities: JSON.parse(row.capabilities) as string[] };
  }

  private touchSession(actor: Actor): void {
    const res = this.db
      .prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ? AND participant_id = ?")
      .run(now(), actor.sessionId, actor.participantId);
    if (res.changes === 0) {
      throw new CollidrError("not_found", "session does not belong to participant; call register first");
    }
  }

  // ------------------------------------------------------------ threads

  getThread(id: string): Thread {
    const t = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as Thread | undefined;
    if (!t) throw new CollidrError("not_found", `thread ${id} not found`);
    return t;
  }

  private isParticipant(threadId: string, participantId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM thread_participants WHERE thread_id = ? AND participant_id = ?")
        .get(threadId, participantId) !== undefined
    );
  }

  private requireParticipant(threadId: string, participantId: string): void {
    if (!this.isParticipant(threadId, participantId)) {
      throw new CollidrError("not_participant", `${participantId} is not a participant in thread ${threadId}`);
    }
  }

  private requireOpen(thread: Thread): void {
    if (thread.status !== "open") {
      throw new CollidrError("thread_closed", `thread ${thread.id} is ${thread.status}`, { status: thread.status });
    }
  }

  openThread(actor: Actor, input: OpenThreadInput): OpenThreadResult {
    const { idempotencyKey, ...args } = input;
    return this.idempotent(actor, idempotencyKey, "open_thread", args, () => {
      if (!THREAD_TYPES.includes(input.type)) throw new CollidrError("invalid_argument", `unknown thread type ${input.type}`);
      requireNonEmpty(input.title, "title");
      const roundLimit = input.roundLimit ?? DEFAULT_ROUND_LIMIT;
      if (!Number.isInteger(roundLimit) || roundLimit < 1) {
        throw new CollidrError("invalid_argument", "round_limit must be an integer >= 1");
      }
      this.getWorkspace(input.workspaceId);
      const reviewers = this.validateReviewers(actor.participantId, input.reviewers);
      this.validateRevisionInput(input);

      const t = now();
      const threadId = ulid();
      this.db
        .prepare(
          "INSERT INTO threads (id, workspace_id, type, title, status, created_by, round_limit, current_round, created_at) VALUES (?, ?, ?, ?, 'open', ?, ?, 1, ?)",
        )
        .run(threadId, input.workspaceId, input.type, input.title, actor.participantId, roundLimit, t);

      const addMember = this.db.prepare(
        "INSERT OR IGNORE INTO thread_participants (thread_id, participant_id, role) VALUES (?, ?, ?)",
      );
      addMember.run(threadId, actor.participantId, "author");
      for (const r of reviewers) addMember.run(threadId, r, "reviewer");
      for (const p of input.participants ?? []) {
        this.getParticipant(p.participantId);
        addMember.run(threadId, p.participantId, requireNonEmpty(p.role, "participant role"));
      }

      const thread = this.getThread(threadId);
      const { revisionId, requestIds } = this.createRevisionWithRequests(actor, thread, 1, 1, input, reviewers);
      return { thread_id: threadId, revision_id: revisionId, request_ids: requestIds };
    });
  }

  submitRevision(actor: Actor, input: SubmitRevisionInput): SubmitRevisionResult {
    const { idempotencyKey, ...args } = input;
    return this.idempotent(actor, idempotencyKey, "submit_revision", args, () => {
      const thread = this.getThread(input.threadId);
      this.requireOpen(thread);
      if (thread.created_by !== actor.participantId) {
        throw new CollidrError("forbidden", "only the thread's author can submit revisions");
      }
      if (thread.current_round >= thread.round_limit) {
        throw new CollidrError(
          "round_limit_reached",
          `thread is on its final round (${thread.current_round} of ${thread.round_limit}); no more revisions`,
          { current_round: thread.current_round, round_limit: thread.round_limit },
        );
      }
      const previousReviewers = (
        this.db
          .prepare("SELECT DISTINCT assignee_id FROM response_requests WHERE thread_id = ? AND round = ? ORDER BY assignee_id")
          .all(thread.id, thread.current_round) as { assignee_id: string }[]
      ).map((r) => r.assignee_id);
      const reviewers = this.validateReviewers(actor.participantId, input.reviewers ?? previousReviewers);
      this.validateRevisionInput(input);

      const addMember = this.db.prepare(
        "INSERT OR IGNORE INTO thread_participants (thread_id, participant_id, role) VALUES (?, ?, 'reviewer')",
      );
      for (const r of reviewers) addMember.run(thread.id, r);

      // Only still-open requests from older revisions are superseded; completed ones stay completed.
      const superseded = this.transitionOpenRequests(thread, "superseded", "request_superseded", actor.participantId);

      const round = thread.current_round + 1;
      const number = (
        this.db.prepare("SELECT MAX(number) AS n FROM revisions WHERE thread_id = ?").get(thread.id) as { n: number }
      ).n + 1;
      this.db.prepare("UPDATE threads SET current_round = ? WHERE id = ?").run(round, thread.id);
      const { revisionId, requestIds } = this.createRevisionWithRequests(
        actor,
        { ...thread, current_round: round },
        number,
        round,
        input,
        reviewers,
      );
      return { revision_id: revisionId, number, round, request_ids: requestIds, superseded_request_ids: superseded };
    });
  }

  private validateReviewers(authorId: string, reviewers: string[] | undefined): string[] {
    const unique = [...new Set(reviewers ?? [])];
    if (unique.length === 0) throw new CollidrError("no_reviewers", "at least one reviewer is required");
    for (const r of unique) {
      if (r === authorId) throw new CollidrError("invalid_argument", "the author cannot review their own revision");
      this.getParticipant(r);
    }
    return unique;
  }

  private validateRevisionInput(input: RevisionInput): void {
    if (!CONTENT_TYPES.includes(input.contentType)) {
      throw new CollidrError("invalid_argument", `unknown content_type ${input.contentType}`);
    }
    if (typeof input.content !== "string" || input.content.length === 0) {
      throw new CollidrError("invalid_argument", "content is required");
    }
    const size = byteLength(input.content);
    if (size > MAX_CONTENT_BYTES) {
      throw new CollidrError("content_too_large", `content is ${size} bytes; the limit is ${MAX_CONTENT_BYTES}`, {
        size,
        limit: MAX_CONTENT_BYTES,
      });
    }
  }

  /** Creates a revision and its fixed, nonempty set of review requests atomically (spec §6). */
  private createRevisionWithRequests(
    actor: Actor,
    thread: Thread,
    number: number,
    round: number,
    input: RevisionInput,
    reviewers: string[],
  ): { revisionId: string; requestIds: string[] } {
    const t = now();
    const revisionId = ulid();
    this.db
      .prepare(
        `INSERT INTO revisions (id, thread_id, number, round, content_type, content, content_size, content_hash,
                                repo_identity, base_commit, head_commit, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        revisionId,
        thread.id,
        number,
        round,
        input.contentType,
        input.content,
        byteLength(input.content),
        sha256(input.content),
        input.repoIdentity ?? null,
        input.baseCommit ?? null,
        input.headCommit ?? null,
        actor.participantId,
        t,
      );
    this.emit(thread, "revision_submitted", revisionId, actor.participantId, null);

    const requestIds: string[] = [];
    const insertRequest = this.db.prepare(
      `INSERT INTO response_requests (id, thread_id, round, target_revision_id, requester_id, assignee_id, kind, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'review', 'open', ?, ?)`,
    );
    for (const reviewer of reviewers) {
      const id = ulid();
      insertRequest.run(id, thread.id, round, revisionId, actor.participantId, reviewer, t, t);
      this.emit(thread, "request_created", id, actor.participantId, null);
      requestIds.push(id);
    }
    return { revisionId, requestIds };
  }

  private transitionOpenRequests(
    thread: Thread,
    to: Extract<RequestStatus, "superseded" | "cancelled">,
    event: Extract<EventType, "request_superseded" | "request_cancelled">,
    actorId: string | null,
  ): string[] {
    const open = (
      this.db.prepare("SELECT id FROM response_requests WHERE thread_id = ? AND status = 'open' ORDER BY id").all(
        thread.id,
      ) as { id: string }[]
    ).map((r) => r.id);
    const update = this.db.prepare("UPDATE response_requests SET status = ?, updated_at = ? WHERE id = ?");
    for (const id of open) {
      update.run(to, now(), id);
      this.emit(thread, event, id, actorId, null);
    }
    return open;
  }

  // ------------------------------------------------------------ messages

  post(actor: Actor, input: PostInput): PostResult {
    const { idempotencyKey, ...args } = input;
    return this.idempotent(actor, idempotencyKey, "post", args, () => {
      const thread = this.getThread(input.threadId);
      this.requireOpen(thread);
      this.requireParticipant(thread.id, actor.participantId);

      if (!MESSAGE_KINDS.includes(input.kind)) throw new CollidrError("invalid_argument", `unknown message kind ${input.kind}`);
      requireNonEmpty(input.body, "body");
      const bodySize = byteLength(input.body);
      if (bodySize > MAX_BODY_BYTES) {
        throw new CollidrError("content_too_large", `body is ${bodySize} bytes; the limit is ${MAX_BODY_BYTES}`, {
          size: bodySize,
          limit: MAX_BODY_BYTES,
        });
      }

      let revisionId = input.revisionId ?? null;
      if (revisionId) this.requireRevisionInThread(thread.id, revisionId);

      if (input.kind === "verdict") {
        if (!input.verdict || !VERDICTS.includes(input.verdict)) {
          throw new CollidrError("invalid_argument", "a verdict post needs verdict: 'approve' or 'request_changes'");
        }
      } else if (input.verdict) {
        throw new CollidrError("invalid_argument", "verdict is only allowed on kind 'verdict'");
      }

      let request: ResponseRequest | null = null;
      if (input.responseRequestId) {
        if (input.kind !== "verdict") {
          throw new CollidrError("verdict_required", "only a verdict can complete a review request");
        }
        request = this.getRequest(input.responseRequestId);
        if (request.thread_id !== thread.id) throw new CollidrError("not_found", "request is not in this thread");
        if (request.assignee_id !== actor.participantId) {
          throw new CollidrError("not_assignee", `request is assigned to ${request.assignee_id}`);
        }
        if (request.status !== "open") {
          throw new CollidrError("request_not_open", `request is ${request.status}`, { status: request.status });
        }
        if (revisionId && revisionId !== request.target_revision_id) {
          throw new CollidrError("stale_revision", "the verdict targets a different revision than the request", {
            target_revision_id: request.target_revision_id,
          });
        }
        revisionId = request.target_revision_id;
      }

      if (input.kind === "verdict" && !revisionId) {
        throw new CollidrError("invalid_argument", "a verdict must reference revision_id or response_request_id");
      }
      if (input.anchors && input.anchors.length > 0) {
        if (!revisionId) throw new CollidrError("invalid_argument", "anchors require revision_id");
        for (const a of input.anchors) {
          if (!a.path || !Number.isInteger(a.line_start) || a.line_start < 1) {
            throw new CollidrError("invalid_argument", "each anchor needs path and a 1-based line_start");
          }
        }
      }
      if (input.replyTo) {
        const parent = this.db.prepare("SELECT thread_id FROM messages WHERE id = ?").get(input.replyTo) as
          | { thread_id: string }
          | undefined;
        if (!parent || parent.thread_id !== thread.id) throw new CollidrError("not_found", "reply_to message not found in thread");
      }
      const recipients = input.recipients && input.recipients.length > 0 ? [...new Set(input.recipients)] : null;
      for (const r of recipients ?? []) this.requireParticipant(thread.id, r);

      const messageId = ulid();
      this.db
        .prepare(
          `INSERT INTO messages (id, thread_id, sender_id, session_id, kind, body, reply_to, recipients, revision_id,
                                 anchors, verdict, response_request_id, evidence, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          messageId,
          thread.id,
          actor.participantId,
          actor.sessionId,
          input.kind,
          input.body,
          input.replyTo ?? null,
          recipients ? JSON.stringify(recipients) : null,
          revisionId,
          input.anchors && input.anchors.length > 0 ? JSON.stringify(input.anchors) : null,
          input.verdict ?? null,
          request?.id ?? null,
          input.evidence === undefined ? null : JSON.stringify(input.evidence),
          now(),
        );
      this.emit(thread, "message_posted", messageId, actor.participantId, recipients);

      if (request) {
        this.db
          .prepare("UPDATE response_requests SET status = 'completed', completed_by_message_id = ?, updated_at = ? WHERE id = ?")
          .run(messageId, now(), request.id);
        this.emit(thread, "request_completed", request.id, actor.participantId, null);
        this.maybeAutoClose(thread.id);
      }

      return {
        message_id: messageId,
        completed_request_id: request?.id ?? null,
        thread_status: this.getThread(thread.id).status,
      };
    });
  }

  private requireRevisionInThread(threadId: string, revisionId: string): void {
    const row = this.db.prepare("SELECT thread_id FROM revisions WHERE id = ?").get(revisionId) as
      | { thread_id: string }
      | undefined;
    if (!row || row.thread_id !== threadId) throw new CollidrError("not_found", `revision ${revisionId} not found in thread`);
  }

  /**
   * On the final permitted round, close the thread once every required review has
   * a verdict: resolved only if all of them approved (spec §6).
   */
  private maybeAutoClose(threadId: string): void {
    const thread = this.getThread(threadId);
    if (thread.status !== "open" || thread.current_round < thread.round_limit) return;

    const requests = this.listRequests(thread.id, thread.current_round);
    if (requests.length === 0 || requests.some((r) => r.status === "open")) return;

    const verdicts = requests.map((r) =>
      r.completed_by_message_id ? this.getMessage(r.completed_by_message_id) : null,
    );
    const allApproved = requests.every((r, i) => r.status === "completed" && verdicts[i]?.verdict === "approve");
    const objections: Objection[] = [];
    requests.forEach((r, i) => {
      const m = verdicts[i];
      if (m && m.verdict === "request_changes") objections.push({ reviewer_id: r.assignee_id, message_id: m.id, body: m.body });
    });
    const latest = this.latestRevision(thread.id);
    this.closeThread(thread, {
      outcome: allApproved ? "resolved" : "unresolved",
      revisionId: latest.id,
      summary: allApproved
        ? `All ${requests.length} required review(s) approved r${latest.number} on the final round.`
        : `Round limit reached; ${objections.length} required review(s) did not approve r${latest.number}.`,
      evidence: null,
      objections,
      resolvedBy: null,
    });
  }

  private closeThread(
    thread: Thread,
    r: {
      outcome: "resolved" | "unresolved";
      revisionId: string;
      summary: string;
      evidence: unknown;
      objections: Objection[];
      resolvedBy: string | null;
    },
  ): void {
    this.transitionOpenRequests(thread, "cancelled", "request_cancelled", r.resolvedBy);
    const t = now();
    this.db.prepare("UPDATE threads SET status = ?, closed_at = ? WHERE id = ?").run(r.outcome, t, thread.id);
    this.db
      .prepare(
        `INSERT INTO resolutions (thread_id, resolved_revision_id, outcome, summary, evidence, outstanding_objections, resolved_by, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        thread.id,
        r.revisionId,
        r.outcome,
        r.summary,
        r.evidence === null || r.evidence === undefined ? null : JSON.stringify(r.evidence),
        JSON.stringify(r.objections),
        r.resolvedBy,
        t,
      );
    this.emit(thread, "thread_closed", thread.id, r.resolvedBy, null);
  }

  resolve(actor: Actor, input: ResolveInput): ResolveResult {
    const { idempotencyKey, ...args } = input;
    return this.idempotent(actor, idempotencyKey, "resolve", args, () => {
      const thread = this.getThread(input.threadId);
      this.requireOpen(thread);
      if (thread.created_by !== actor.participantId) {
        throw new CollidrError("forbidden", "only the thread's author can resolve it");
      }
      if (input.outcome !== "resolved" && input.outcome !== "unresolved") {
        throw new CollidrError("invalid_argument", "outcome must be 'resolved' or 'unresolved'");
      }
      requireNonEmpty(input.summary, "summary");
      const latest = this.latestRevision(thread.id);
      if (latest.id !== input.expectedRevisionId) {
        throw new CollidrError("stale_revision", `the latest revision is r${latest.number}`, {
          latest_revision_id: latest.id,
          latest_number: latest.number,
        });
      }
      this.closeThread(thread, {
        outcome: input.outcome,
        revisionId: latest.id,
        summary: input.summary,
        evidence: input.evidence ?? null,
        objections: input.outstandingObjections ?? [],
        resolvedBy: actor.participantId,
      });
      return { thread_id: thread.id, outcome: input.outcome, resolved_revision_id: latest.id };
    });
  }

  // ------------------------------------------------------------ events & cursors

  private emit(
    thread: Pick<Thread, "id" | "workspace_id">,
    type: EventType,
    refId: string,
    actorId: string | null,
    recipients: string[] | null,
  ): void {
    this.db
      .prepare(
        "INSERT INTO events (workspace_id, thread_id, type, ref_id, actor_id, recipients, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(thread.workspace_id, thread.id, type, refId, actorId, recipients ? JSON.stringify(recipients) : null, now());
  }

  maxSeq(): number {
    return (this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events").get() as { s: number }).s;
  }

  /**
   * Events visible to a participant: on threads they belong to, not directed only
   * at someone else, and not caused by themselves. Optionally limited to one
   * thread or workspace. Reading never consumes anything.
   */
  listVisibleEvents(
    participantId: string,
    opts: { afterSeq?: number; threadId?: string; workspaceId?: string; limit?: number; includeOwn?: boolean } = {},
  ): EventPage {
    const limit = clampLimit(opts.limit, DEFAULT_PAGE, MAX_PAGE);
    const after = opts.afterSeq ?? 0;
    const where = [
      "e.seq > @after",
      "(e.recipients IS NULL OR EXISTS (SELECT 1 FROM json_each(e.recipients) WHERE value = @pid))",
    ];
    if (!opts.includeOwn) where.push("(e.actor_id IS NULL OR e.actor_id != @pid)");
    if (opts.threadId) where.push("e.thread_id = @thread");
    if (opts.workspaceId) where.push("e.workspace_id = @workspace");
    const rows = this.db
      .prepare(
        `SELECT e.* FROM events e
         JOIN thread_participants tp ON tp.thread_id = e.thread_id AND tp.participant_id = @pid
         WHERE ${where.join(" AND ")}
         ORDER BY e.seq LIMIT @limit`,
      )
      .all({ after, pid: participantId, thread: opts.threadId ?? null, workspace: opts.workspaceId ?? null, limit: limit + 1 }) as EventRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map((r) => this.hydrate(r));
    return { events: page, event_cursor: page.length > 0 ? page[page.length - 1]!.seq : after, has_more: hasMore };
  }

  /** Every event, regardless of participant: the human operator's view (CLI watch). */
  listAllEvents(opts: { afterSeq?: number; threadId?: string; workspaceId?: string; limit?: number } = {}): EventPage {
    const limit = clampLimit(opts.limit, DEFAULT_PAGE, MAX_PAGE);
    const after = opts.afterSeq ?? 0;
    const where = ["seq > @after"];
    if (opts.threadId) where.push("thread_id = @thread");
    if (opts.workspaceId) where.push("workspace_id = @workspace");
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY seq LIMIT @limit`)
      .all({ after, thread: opts.threadId ?? null, workspace: opts.workspaceId ?? null, limit: limit + 1 }) as EventRow[];
    const page = rows.slice(0, limit).map((r) => this.hydrate(r));
    return { events: page, event_cursor: page.length > 0 ? page[page.length - 1]!.seq : after, has_more: rows.length > limit };
  }

  private hydrate(row: EventRow): HubEvent {
    const ev: HubEvent = { ...row, recipients: parseJson<string[]>(row.recipients) };
    switch (row.type) {
      case "message_posted":
        ev.message = this.getMessage(row.ref_id);
        break;
      case "request_created":
      case "request_completed":
      case "request_superseded":
      case "request_cancelled":
        ev.request = this.getRequest(row.ref_id);
        break;
      case "revision_submitted":
        ev.revision = this.getRevisionMeta(row.ref_id);
        break;
      case "thread_closed": {
        const res = this.getResolution(row.thread_id);
        if (res) ev.resolution = res;
        break;
      }
    }
    return ev;
  }

  /** Persist a resume point. Cursors never move backward (spec §5). */
  ack(participantId: string, scope: string, seq: number): number {
    if (scope !== "inbox" && !/^thread:[0-9A-Z]{26}$/.test(scope)) {
      throw new CollidrError("invalid_argument", "scope must be 'inbox' or 'thread:<thread_id>'");
    }
    if (!Number.isInteger(seq) || seq < 0) throw new CollidrError("invalid_argument", "cursor must be a non-negative integer");
    return this.db
      .transaction(() => {
        this.getParticipant(participantId);
        if (seq > this.maxSeq()) throw new CollidrError("invalid_argument", "cannot ack beyond the latest event");
        this.db
          .prepare(
            `INSERT INTO cursors (participant_id, scope, acked_seq, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (participant_id, scope) DO UPDATE SET
               acked_seq = MAX(acked_seq, excluded.acked_seq), updated_at = excluded.updated_at`,
          )
          .run(participantId, scope, seq, now());
        return (
          this.db.prepare("SELECT acked_seq FROM cursors WHERE participant_id = ? AND scope = ?").get(participantId, scope) as {
            acked_seq: number;
          }
        ).acked_seq;
      })
      .immediate();
  }

  getCursors(participantId: string): Record<string, number> {
    const rows = this.db.prepare("SELECT scope, acked_seq FROM cursors WHERE participant_id = ?").all(participantId) as {
      scope: string;
      acked_seq: number;
    }[];
    return Object.fromEntries(rows.map((r) => [r.scope, r.acked_seq]));
  }

  // ------------------------------------------------------------ reads

  getMessage(id: string): Message {
    const row = this.db
      .prepare(
        `SELECT m.*, s.client AS sender_client, s.model AS sender_model
         FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.id = ?`,
      )
      .get(id) as MessageRow | undefined;
    if (!row) throw new CollidrError("not_found", `message ${id} not found`);
    return {
      ...row,
      recipients: parseJson<string[]>(row.recipients),
      anchors: parseJson<Anchor[]>(row.anchors),
      evidence: parseJson<unknown>(row.evidence),
    };
  }

  getRequest(id: string): ResponseRequest {
    const r = this.db.prepare("SELECT * FROM response_requests WHERE id = ?").get(id) as ResponseRequest | undefined;
    if (!r) throw new CollidrError("not_found", `request ${id} not found`);
    return r;
  }

  listRequests(threadId: string, round?: number): ResponseRequest[] {
    return round === undefined
      ? (this.db.prepare("SELECT * FROM response_requests WHERE thread_id = ? ORDER BY id").all(threadId) as ResponseRequest[])
      : (this.db
          .prepare("SELECT * FROM response_requests WHERE thread_id = ? AND round = ? ORDER BY id")
          .all(threadId, round) as ResponseRequest[]);
  }

  getRevisionMeta(id: string): RevisionMeta {
    const r = this.db.prepare(`SELECT ${REVISION_META_COLUMNS} FROM revisions WHERE id = ?`).get(id) as
      | RevisionMeta
      | undefined;
    if (!r) throw new CollidrError("not_found", `revision ${id} not found`);
    return r;
  }

  latestRevision(threadId: string): RevisionMeta {
    const r = this.db
      .prepare(`SELECT ${REVISION_META_COLUMNS} FROM revisions WHERE thread_id = ? ORDER BY number DESC LIMIT 1`)
      .get(threadId) as RevisionMeta | undefined;
    if (!r) throw new CollidrError("not_found", `thread ${threadId} has no revisions`);
    return r;
  }

  getResolution(threadId: string): Resolution | null {
    const row = this.db.prepare("SELECT * FROM resolutions WHERE thread_id = ?").get(threadId) as ResolutionRow | undefined;
    if (!row) return null;
    return {
      ...row,
      evidence: parseJson<unknown>(row.evidence),
      outstanding_objections: JSON.parse(row.outstanding_objections) as Objection[],
    };
  }

  /**
   * Page through a revision's immutable content by lines. The content cursor is
   * independent of delivery: reading content never touches event cursors.
   */
  readRevision(
    participantId: string,
    threadId: string,
    revisionId: string,
    opts: { contentCursor?: number; limit?: number } = {},
  ): RevisionPage {
    this.requireParticipant(threadId, participantId);
    this.requireRevisionInThread(threadId, revisionId);
    const limit = clampLimit(opts.limit, DEFAULT_CONTENT_LINES, MAX_CONTENT_LINES);
    const start = opts.contentCursor ?? 0;
    if (!Number.isInteger(start) || start < 0) throw new CollidrError("invalid_argument", "content_cursor must be >= 0");
    const { content } = this.db.prepare("SELECT content FROM revisions WHERE id = ?").get(revisionId) as { content: string };
    const all = content.split("\n");
    const lines = all.slice(start, start + limit);
    const next = start + lines.length;
    return {
      revision: this.getRevisionMeta(revisionId),
      start_line: start,
      lines,
      total_lines: all.length,
      content_cursor: next < all.length ? next : null,
    };
  }

  threadSummary(threadId: string): ThreadSummary {
    const thread = this.getThread(threadId);
    const participants = this.db
      .prepare("SELECT participant_id, role FROM thread_participants WHERE thread_id = ? ORDER BY participant_id")
      .all(threadId) as { participant_id: string; role: string }[];
    const requests = this.listRequests(threadId, thread.current_round);
    return {
      thread,
      participants,
      latest_revision: this.latestRevision(threadId),
      current_round_requests: requests,
      awaiting: requests.filter((r) => r.status === "open").map((r) => r.assignee_id),
      resolution: this.getResolution(threadId),
    };
  }

  listThreads(
    workspaceId: string,
    opts: { status?: Thread["status"]; participantId?: string; afterId?: string; limit?: number } = {},
  ): { threads: Thread[]; next_after_id: string | null } {
    const limit = clampLimit(opts.limit, DEFAULT_PAGE, MAX_PAGE);
    const where = ["t.workspace_id = @ws", "t.id > @after"];
    if (opts.status) where.push("t.status = @status");
    if (opts.participantId) {
      where.push("EXISTS (SELECT 1 FROM thread_participants tp WHERE tp.thread_id = t.id AND tp.participant_id = @pid)");
    }
    const rows = this.db
      .prepare(`SELECT t.* FROM threads t WHERE ${where.join(" AND ")} ORDER BY t.id LIMIT @limit`)
      .all({
        ws: workspaceId,
        after: opts.afterId ?? "",
        status: opts.status ?? null,
        pid: opts.participantId ?? null,
        limit: limit + 1,
      }) as Thread[];
    const page = rows.slice(0, limit);
    return { threads: page, next_after_id: rows.length > limit ? page[page.length - 1]!.id : null };
  }
}
