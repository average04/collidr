export type ThreadType = "diff_review" | "plan_review";
export type ThreadStatus = "open" | "resolved" | "unresolved";
export type ContentType = "patch" | "snapshot" | "plan";
export type MessageKind = "comment" | "question" | "proposal" | "objection" | "verdict" | "system";
export type Verdict = "approve" | "request_changes";
export type RequestStatus = "open" | "completed" | "superseded" | "cancelled";
export type EventType =
  | "message_posted"
  | "request_created"
  | "request_completed"
  | "request_superseded"
  | "request_cancelled"
  | "revision_submitted"
  | "thread_closed";

/** Who is calling: a participant acting through one session. */
export interface Actor {
  participantId: string;
  sessionId: string;
}

export interface Anchor {
  path: string;
  line_start: number;
  line_end?: number;
}

export interface Workspace {
  id: string;
  repo_root: string;
  repo_remote: string | null;
  created_at: string;
}

export interface Participant {
  id: string;
  display_name: string;
  default_client: string | null;
  default_model: string | null;
  default_role: string | null;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  participant_id: string;
  client: string | null;
  model: string | null;
  role: string | null;
  capabilities: string[];
  started_at: string;
  last_seen_at: string;
}

export interface Thread {
  id: string;
  workspace_id: string;
  type: ThreadType;
  title: string;
  status: ThreadStatus;
  created_by: string;
  round_limit: number;
  current_round: number;
  created_at: string;
  closed_at: string | null;
}

export interface RevisionMeta {
  id: string;
  thread_id: string;
  number: number;
  round: number;
  content_type: ContentType;
  content_size: number;
  content_hash: string;
  repo_identity: string | null;
  base_commit: string | null;
  head_commit: string | null;
  created_by: string;
  created_at: string;
}

export interface ResponseRequest {
  id: string;
  thread_id: string;
  round: number;
  target_revision_id: string;
  requester_id: string;
  assignee_id: string;
  kind: "review";
  status: RequestStatus;
  completed_by_message_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  thread_id: string;
  sender_id: string;
  session_id: string;
  /** Model/client snapshot from the sending session, for historical attribution. */
  sender_client: string | null;
  sender_model: string | null;
  kind: MessageKind;
  body: string;
  reply_to: string | null;
  recipients: string[] | null;
  revision_id: string | null;
  anchors: Anchor[] | null;
  verdict: Verdict | null;
  response_request_id: string | null;
  evidence: unknown;
  created_at: string;
}

export interface Objection {
  reviewer_id: string;
  message_id: string;
  body: string;
}

export interface Resolution {
  thread_id: string;
  resolved_revision_id: string;
  outcome: "resolved" | "unresolved";
  summary: string;
  evidence: unknown;
  outstanding_objections: Objection[];
  /** null when the thread closed automatically at its round limit. */
  resolved_by: string | null;
  resolved_at: string;
}

export interface HubEvent {
  seq: number;
  workspace_id: string;
  thread_id: string;
  type: EventType;
  ref_id: string;
  actor_id: string | null;
  recipients: string[] | null;
  created_at: string;
  /** The object the event refers to, hydrated for convenience. */
  message?: Message;
  request?: ResponseRequest;
  revision?: RevisionMeta;
  resolution?: Resolution;
}
