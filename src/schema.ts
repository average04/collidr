/**
 * Versioned schema migrations (spec §4, §8). Each migration runs once, in order,
 * inside an exclusive transaction, and bumps PRAGMA user_version.
 *
 * Never edit a released migration; add a new one instead.
 */
export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: /* sql */ `
      CREATE TABLE workspaces (
        id           TEXT PRIMARY KEY,
        repo_root    TEXT NOT NULL UNIQUE,
        repo_remote  TEXT,
        created_at   TEXT NOT NULL
      );

      CREATE TABLE participants (
        id              TEXT PRIMARY KEY,
        display_name    TEXT NOT NULL,
        default_client  TEXT,
        default_model   TEXT,
        default_role    TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      -- One row per connection/run. Snapshots client, model and capabilities so
      -- history is never rewritten when a participant resumes with another model.
      CREATE TABLE sessions (
        id              TEXT PRIMARY KEY,
        participant_id  TEXT NOT NULL REFERENCES participants(id),
        client          TEXT,
        model           TEXT,
        role            TEXT,
        capabilities    TEXT NOT NULL DEFAULT '[]',
        started_at      TEXT NOT NULL,
        last_seen_at    TEXT NOT NULL
      );
      CREATE INDEX sessions_participant ON sessions(participant_id);

      CREATE TABLE threads (
        id             TEXT PRIMARY KEY,
        workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
        type           TEXT NOT NULL CHECK (type IN ('diff_review', 'plan_review')),
        title          TEXT NOT NULL,
        status         TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'unresolved')),
        created_by     TEXT NOT NULL REFERENCES participants(id),
        round_limit    INTEGER NOT NULL CHECK (round_limit >= 1),
        current_round  INTEGER NOT NULL,
        created_at     TEXT NOT NULL,
        closed_at      TEXT
      );
      CREATE INDEX threads_workspace ON threads(workspace_id, status);

      CREATE TABLE thread_participants (
        thread_id       TEXT NOT NULL REFERENCES threads(id),
        participant_id  TEXT NOT NULL REFERENCES participants(id),
        role            TEXT NOT NULL,
        PRIMARY KEY (thread_id, participant_id)
      );
      CREATE INDEX thread_participants_participant ON thread_participants(participant_id);

      CREATE TABLE revisions (
        id             TEXT PRIMARY KEY,
        thread_id      TEXT NOT NULL REFERENCES threads(id),
        number         INTEGER NOT NULL,
        round          INTEGER NOT NULL,
        content_type   TEXT NOT NULL CHECK (content_type IN ('patch', 'snapshot', 'plan')),
        content        TEXT NOT NULL,
        content_size   INTEGER NOT NULL,
        content_hash   TEXT NOT NULL,
        repo_identity  TEXT,
        base_commit    TEXT,
        head_commit    TEXT,
        created_by     TEXT NOT NULL REFERENCES participants(id),
        created_at     TEXT NOT NULL,
        UNIQUE (thread_id, number)
      );

      CREATE TABLE response_requests (
        id                       TEXT PRIMARY KEY,
        thread_id                TEXT NOT NULL REFERENCES threads(id),
        round                    INTEGER NOT NULL,
        target_revision_id       TEXT NOT NULL REFERENCES revisions(id),
        requester_id             TEXT NOT NULL REFERENCES participants(id),
        assignee_id              TEXT NOT NULL REFERENCES participants(id),
        kind                     TEXT NOT NULL CHECK (kind IN ('review')),
        status                   TEXT NOT NULL CHECK (status IN ('open', 'completed', 'superseded', 'cancelled')),
        completed_by_message_id  TEXT,
        deadline                 TEXT,  -- (later) not enforced in v1
        claim_expires_at         TEXT,  -- (later) not enforced in v1
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL
      );
      CREATE INDEX response_requests_thread ON response_requests(thread_id, round, status);
      CREATE INDEX response_requests_assignee ON response_requests(assignee_id, status);

      CREATE TABLE messages (
        id                   TEXT PRIMARY KEY,
        thread_id            TEXT NOT NULL REFERENCES threads(id),
        sender_id            TEXT NOT NULL REFERENCES participants(id),
        session_id           TEXT NOT NULL REFERENCES sessions(id),
        kind                 TEXT NOT NULL CHECK (kind IN ('comment', 'question', 'proposal', 'objection', 'verdict', 'system')),
        body                 TEXT NOT NULL,
        reply_to             TEXT REFERENCES messages(id),
        recipients           TEXT,           -- JSON array of participant ids; NULL = everyone in the thread
        revision_id          TEXT REFERENCES revisions(id),
        anchors              TEXT,           -- JSON array of {path, line_start, line_end}
        verdict              TEXT CHECK (verdict IN ('approve', 'request_changes')),
        response_request_id  TEXT REFERENCES response_requests(id),
        evidence             TEXT,           -- JSON, self-reported in v1
        created_at           TEXT NOT NULL
      );
      CREATE INDEX messages_thread ON messages(thread_id);

      -- The single durable sequence for every inbox-visible change (spec §5).
      CREATE TABLE events (
        seq           INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
        thread_id     TEXT NOT NULL REFERENCES threads(id),
        type          TEXT NOT NULL CHECK (type IN (
                        'message_posted', 'request_created', 'request_completed',
                        'request_superseded', 'request_cancelled',
                        'revision_submitted', 'thread_closed')),
        ref_id        TEXT NOT NULL,
        actor_id      TEXT,                  -- NULL for system-generated events
        recipients    TEXT,                  -- JSON array; NULL = everyone in the thread
        created_at    TEXT NOT NULL
      );
      CREATE INDEX events_thread ON events(thread_id, seq);

      CREATE TABLE idempotency_records (
        participant_id    TEXT NOT NULL REFERENCES participants(id),
        key               TEXT NOT NULL,
        operation         TEXT NOT NULL,
        args_fingerprint  TEXT NOT NULL,
        result            TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        PRIMARY KEY (participant_id, key)
      );

      CREATE TABLE cursors (
        participant_id  TEXT NOT NULL REFERENCES participants(id),
        scope           TEXT NOT NULL,       -- 'inbox' or 'thread:<id>'
        acked_seq       INTEGER NOT NULL,
        updated_at      TEXT NOT NULL,
        PRIMARY KEY (participant_id, scope)
      );

      CREATE TABLE resolutions (
        thread_id               TEXT PRIMARY KEY REFERENCES threads(id),
        resolved_revision_id    TEXT NOT NULL REFERENCES revisions(id),
        outcome                 TEXT NOT NULL CHECK (outcome IN ('resolved', 'unresolved')),
        summary                 TEXT NOT NULL,
        evidence                TEXT,
        outstanding_objections  TEXT NOT NULL DEFAULT '[]',
        resolved_by             TEXT REFERENCES participants(id),  -- NULL = closed automatically
        resolved_at             TEXT NOT NULL
      );
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
