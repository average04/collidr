import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ulid } from "ulid";
import { captureProcessIdentity, processAlive, processMatchesIdentity } from "./process-identity.js";
import type { Provider } from "./types.js";
export { processAlive } from "./process-identity.js";

export interface RunWork {
  taskId: string | null;
  threadId: string | null;
  eventSeq: number | null;
  eventStartSeq?: number;
  deferredThread?: boolean;
}

export interface ActiveRun extends RunWork {
  id: string;
  startedAt: number;
  childPid: number | null;
  childIdentity?: string | null;
}

export interface AgentState {
  agentId: string;
  provider: Provider | null;
  sessionId: string | null;
  cursor: number;
  blockedReason: string | null;
  output: string;
  active: ActiveRun | null;
}

export interface QueuedTask {
  id: string;
  agentId: string;
  prompt: string;
  status: "queued" | "running" | "blocked" | "completed";
  createdAt: number;
}

interface Lease {
  owner: string;
  pid: number;
  processIdentity: string | null;
  heartbeatAt: number;
  stopRequested: boolean;
}

export interface RunnerStatus {
  workspace: string;
  lease: Lease | null;
  agents: AgentState[];
  tasks: QueuedTask[];
  budgets: { threadId: string; invocations: number; additionalInvocations: number }[];
  deferredThreads: DeferredThread[];
}

export interface DeferredThread {
  agentId: string;
  threadId: string;
  fromSeq: number;
  throughSeq: number;
  blockedReason: string | null;
}

interface AgentRow {
  agent_id: string;
  provider: Provider | null;
  session_id: string | null;
  cursor: number;
  blocked_reason: string | null;
  output: string;
  active: string | null;
}

const LEASE_TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT = 64 * 1024;
const CHILD_IDENTITY_CHECK_MS = 5000;

function hydrate(row: AgentRow): AgentState {
  return {
    agentId: row.agent_id,
    provider: row.provider,
    sessionId: row.session_id,
    cursor: row.cursor,
    blockedReason: row.blocked_reason,
    output: row.output,
    active: row.active === null ? null : JSON.parse(row.active) as ActiveRun,
  };
}

/** Durable scheduling state lives entirely outside the Collidr hub schema. */
export class RunnerState {
  readonly file: string;
  private readonly db: Database.Database;
  private closed = false;
  private readonly childIdentityChecks = new Map<string, number>();

  constructor(database: string) {
    this.file = `${database}.runner.db`;
    mkdirSync(dirname(this.file), { recursive: true });
    this.db = new Database(this.file);
    try {
      this.db.pragma("busy_timeout = 5000");
      this.db.transaction(() => {
        const version = this.db.pragma("user_version", { simple: true }) as number;
        if (version > 3) throw new Error(`Runner state schema version ${version} is newer than supported version 3.`);
        if (version === 3) return;
        if (version === 0) this.db.exec(`
      CREATE TABLE IF NOT EXISTS runner_leases (
        workspace TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL, stop_requested INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS runner_agents (
        workspace TEXT NOT NULL, agent_id TEXT NOT NULL, provider TEXT, session_id TEXT,
        cursor INTEGER NOT NULL DEFAULT 0, blocked_reason TEXT, output TEXT NOT NULL DEFAULT '', active TEXT,
        PRIMARY KEY (workspace, agent_id)
      );
      CREATE TABLE IF NOT EXISTS runner_tasks (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL, agent_id TEXT NOT NULL,
        prompt TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runner_tasks_pending ON runner_tasks(workspace, agent_id, status, id);
      CREATE TABLE IF NOT EXISTS runner_budgets (
        workspace TEXT NOT NULL, thread_id TEXT NOT NULL, invocations INTEGER NOT NULL,
        PRIMARY KEY (workspace, thread_id)
      );
      CREATE TABLE IF NOT EXISTS runner_rotation (workspace TEXT PRIMARY KEY, last_agent_id TEXT NOT NULL);
        `);
        if (version < 2) {
          this.db.exec(`
          ALTER TABLE runner_budgets ADD COLUMN additional_invocations INTEGER NOT NULL DEFAULT 0;
          CREATE TABLE runner_thread_work (
            workspace TEXT NOT NULL, agent_id TEXT NOT NULL, thread_id TEXT NOT NULL,
            first_seq INTEGER NOT NULL, through_seq INTEGER NOT NULL, blocked_reason TEXT,
            PRIMARY KEY (workspace, agent_id, thread_id)
          );
        `);
          // v1 left the failing event beyond the global cursor. Preserve that
          // position and move only the recognizable budget block off the agent.
          for (const row of this.db.prepare("SELECT workspace, agent_id, cursor, blocked_reason FROM runner_agents WHERE blocked_reason IS NOT NULL AND active IS NULL").all() as { workspace: string; agent_id: string; cursor: number; blocked_reason: string }[]) {
            const match = /^Thread (.+) reached its \d+-invocation budget\.$/.exec(row.blocked_reason);
            if (!match) continue;
            this.db.prepare("INSERT INTO runner_thread_work VALUES (?, ?, ?, ?, ?, ?)")
              .run(row.workspace, row.agent_id, match[1], row.cursor + 1, row.cursor + 1, row.blocked_reason);
            this.db.prepare("UPDATE runner_agents SET blocked_reason = NULL WHERE workspace = ? AND agent_id = ?")
              .run(row.workspace, row.agent_id);
          }
        }
        this.db.exec("ALTER TABLE runner_leases ADD COLUMN process_identity TEXT");
        this.db.pragma("user_version = 3");
      }).exclusive();
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  acquire(workspace: string, owner: string, pid = process.pid): boolean {
    return this.db.transaction(() => {
      const lease = this.lease(workspace);
      if (lease) {
        if (lease.owner === owner && lease.pid === pid && processMatchesIdentity(lease.pid, lease.processIdentity)) {
          this.heartbeat(workspace, owner);
          return true;
        }
        if (Date.now() - lease.heartbeatAt < LEASE_TIMEOUT_MS || processMatchesIdentity(lease.pid, lease.processIdentity)) return false;
      }
      const active = this.agents(workspace).filter((agent) => agent.active !== null);
      if (active.some((agent) => agent.active!.childPid !== null && processMatchesIdentity(agent.active!.childPid!, agent.active!.childIdentity))) return false;
      for (const agent of active) {
        this.finishRun(workspace, agent.agentId, agent.active!.id, {
          status: "blocked", output: agent.output,
          reason: agent.blockedReason ?? "Interrupted runner invocation; inspect Collidr progress before retrying.",
        });
      }
      this.db.prepare(`INSERT INTO runner_leases (workspace, owner, pid, heartbeat_at, stop_requested, process_identity)
        VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(workspace) DO UPDATE SET
        owner = excluded.owner, pid = excluded.pid, heartbeat_at = excluded.heartbeat_at, stop_requested = 0,
        process_identity = excluded.process_identity`)
        .run(workspace, owner, pid, Date.now(), captureProcessIdentity(pid));
      return true;
    }).immediate();
  }

  heartbeat(workspace: string, owner: string): void {
    this.db.prepare("UPDATE runner_leases SET heartbeat_at = ? WHERE workspace = ? AND owner = ?")
      .run(Date.now(), workspace, owner);
  }

  release(workspace: string, owner: string): void {
    this.db.prepare("DELETE FROM runner_leases WHERE workspace = ? AND owner = ?").run(workspace, owner);
  }

  requestStop(workspace: string): void {
    this.db.prepare("UPDATE runner_leases SET stop_requested = 1 WHERE workspace = ?").run(workspace);
  }

  shouldStop(workspace: string, owner: string): boolean {
    const lease = this.lease(workspace);
    return !lease || lease.owner !== owner || lease.stopRequested;
  }

  private lease(workspace: string): Lease | null {
    const row = this.db.prepare("SELECT owner, pid, heartbeat_at, stop_requested, process_identity FROM runner_leases WHERE workspace = ?")
      .get(workspace) as { owner: string; pid: number; heartbeat_at: number; stop_requested: number; process_identity: string | null } | undefined;
    return row ? { owner: row.owner, pid: row.pid, processIdentity: row.process_identity, heartbeatAt: row.heartbeat_at, stopRequested: row.stop_requested !== 0 } : null;
  }

  private agents(workspace: string): AgentState[] {
    return (this.db.prepare("SELECT * FROM runner_agents WHERE workspace = ? ORDER BY agent_id").all(workspace) as AgentRow[]).map(hydrate);
  }

  status(workspace: string): RunnerStatus {
    return this.db.transaction(() => ({
      workspace,
      lease: this.lease(workspace),
      agents: this.agents(workspace),
      tasks: this.db.prepare(`SELECT id, agent_id AS agentId, prompt, status, created_at AS createdAt
        FROM runner_tasks WHERE workspace = ? ORDER BY rowid`).all(workspace) as QueuedTask[],
      budgets: this.db.prepare("SELECT thread_id AS threadId, invocations, additional_invocations AS additionalInvocations FROM runner_budgets WHERE workspace = ? ORDER BY thread_id")
        .all(workspace) as RunnerStatus["budgets"],
      deferredThreads: this.deferredThreads(workspace),
    })).deferred();
  }

  ensureAgent(workspace: string, agentId: string, provider?: Provider): void {
    this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO runner_agents (workspace, agent_id, provider) VALUES (?, ?, ?)").run(workspace, agentId, provider ?? null);
      if (provider) {
        const row = this.db.prepare("SELECT * FROM runner_agents WHERE workspace = ? AND agent_id = ?").get(workspace, agentId) as AgentRow;
        if (row.provider && row.provider !== provider && (row.session_id || row.active)) {
          throw new Error(`Agent ${agentId} has a ${row.provider} session and cannot switch provider to ${provider}; use a new participant ID.`);
        }
        this.db.prepare("UPDATE runner_agents SET provider = ? WHERE workspace = ? AND agent_id = ?").run(provider, workspace, agentId);
      }
    }).immediate();
  }

  getAgent(workspace: string, agentId: string): AgentState {
    this.ensureAgent(workspace, agentId);
    return hydrate(this.db.prepare("SELECT * FROM runner_agents WHERE workspace = ? AND agent_id = ?").get(workspace, agentId) as AgentRow);
  }

  enqueue(workspace: string, agentId: string, prompt: string): string {
    if (!prompt.trim()) throw new Error("Task prompt must not be empty.");
    return this.db.transaction(() => {
      this.ensureAgent(workspace, agentId);
      const id = ulid();
      this.db.prepare("INSERT INTO runner_tasks (id, workspace, agent_id, prompt, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)")
        .run(id, workspace, agentId, prompt, Date.now());
      return id;
    }).immediate();
  }

  pendingTask(workspace: string, agentId: string): QueuedTask | null {
    return this.db.prepare(`SELECT id, agent_id AS agentId, prompt, status, created_at AS createdAt
      FROM runner_tasks WHERE workspace = ? AND agent_id = ? AND status = 'queued' ORDER BY rowid LIMIT 1`)
      .get(workspace, agentId) as QueuedTask | undefined ?? null;
  }

  retry(workspace: string, agentId: string, threadId?: string, additionalInvocations?: number): void {
    this.db.transaction(() => {
      const agent = this.getAgent(workspace, agentId);
      if (agent.active) throw new Error(`Agent ${agentId} still has an active invocation; wait for its child to exit or restart the supervisor.`);
      if (threadId) {
        if (!Number.isSafeInteger(additionalInvocations) || additionalInvocations! <= 0) throw new Error("A thread retry must grant a positive invocation allowance.");
        const parked = this.deferredThreads(workspace).find(item => item.agentId === agentId && item.threadId === threadId);
        if (!parked?.blockedReason) throw new Error(`No budget-parked work for agent ${agentId} on thread ${threadId}.`);
        this.db.prepare("UPDATE runner_budgets SET additional_invocations = additional_invocations + ? WHERE workspace = ? AND thread_id = ?")
          .run(additionalInvocations!, workspace, threadId);
        this.db.prepare("UPDATE runner_thread_work SET blocked_reason = NULL WHERE workspace = ? AND agent_id = ? AND thread_id = ?")
          .run(workspace, agentId, threadId);
        return;
      }
      this.db.prepare("UPDATE runner_agents SET blocked_reason = NULL WHERE workspace = ? AND agent_id = ?").run(workspace, agentId);
      this.db.prepare("UPDATE runner_tasks SET status = 'queued' WHERE workspace = ? AND agent_id = ? AND status = 'blocked'").run(workspace, agentId);
    }).immediate();
  }

  advance(workspace: string, agentId: string, seq: number): void {
    this.db.prepare("UPDATE runner_agents SET cursor = MAX(cursor, ?) WHERE workspace = ? AND agent_id = ?").run(seq, workspace, agentId);
  }

  getBudget(workspace: string, threadId: string): number {
    return (this.db.prepare("SELECT invocations FROM runner_budgets WHERE workspace = ? AND thread_id = ?")
      .get(workspace, threadId) as { invocations: number } | undefined)?.invocations ?? 0;
  }

  deferredThreads(workspace: string): DeferredThread[] {
    return this.db.prepare(`SELECT agent_id AS agentId, thread_id AS threadId, first_seq AS fromSeq,
      through_seq AS throughSeq, blocked_reason AS blockedReason FROM runner_thread_work WHERE workspace = ? ORDER BY first_seq, agent_id, thread_id`)
      .all(workspace) as DeferredThread[];
  }

  /** Persist the pending thread range before advancing the independent inbox cursor. */
  deferIfBudgetExhausted(workspace: string, agentId: string, work: RunWork, maxTurns: number): boolean {
    if (!work.threadId) return false;
    return this.db.transaction(() => {
      const budget = this.db.prepare("SELECT invocations, additional_invocations FROM runner_budgets WHERE workspace = ? AND thread_id = ?")
        .get(workspace, work.threadId) as { invocations: number; additional_invocations: number } | undefined;
      const parked = this.deferredThreads(workspace).find(item => item.agentId === agentId && item.threadId === work.threadId);
      if (!parked?.blockedReason && (budget?.invocations ?? 0) < maxTurns + (budget?.additional_invocations ?? 0)) return false;
      if (work.eventSeq === null) throw new Error("Thread budget work requires an event checkpoint.");
      const reason = parked?.blockedReason ?? `Thread ${work.threadId} reached its ${maxTurns + (budget?.additional_invocations ?? 0)}-invocation budget. Retry this thread explicitly to grant another allowance.`;
      this.db.prepare(`INSERT INTO runner_thread_work (workspace, agent_id, thread_id, first_seq, through_seq, blocked_reason) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace, agent_id, thread_id) DO UPDATE SET first_seq = MIN(first_seq, excluded.first_seq), through_seq = MAX(through_seq, excluded.through_seq), blocked_reason = excluded.blocked_reason`)
        .run(workspace, agentId, work.threadId, work.eventStartSeq ?? work.eventSeq, work.eventSeq, reason);
      if (!work.deferredThread) this.advance(workspace, agentId, work.eventSeq);
      return true;
    }).immediate();
  }

  advanceDeferredThread(workspace: string, agentId: string, threadId: string, seq: number): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM runner_thread_work WHERE workspace = ? AND agent_id = ? AND thread_id = ? AND through_seq <= ?")
        .run(workspace, agentId, threadId, seq);
      this.db.prepare("UPDATE runner_thread_work SET first_seq = MAX(first_seq, ?) WHERE workspace = ? AND agent_id = ? AND thread_id = ?")
        .run(seq + 1, workspace, agentId, threadId);
    }).immediate();
  }

  addBudget(workspace: string, threadId: string): void {
    this.db.prepare(`INSERT INTO runner_budgets (workspace, thread_id, invocations) VALUES (?, ?, 1)
      ON CONFLICT(workspace, thread_id) DO UPDATE SET invocations = invocations + 1`).run(workspace, threadId);
  }

  lastAgent(workspace: string): string | null {
    return (this.db.prepare("SELECT last_agent_id FROM runner_rotation WHERE workspace = ?").get(workspace) as { last_agent_id: string } | undefined)?.last_agent_id ?? null;
  }

  /** The IMMEDIATE transaction also serializes callers sharing the supervisor lease. */
  beginRun(workspace: string, agentId: string, work: RunWork, maxTurns: number): ActiveRun | null {
    return this.db.transaction(() => {
      const agent = this.getAgent(workspace, agentId);
      if (agent.blockedReason || this.agents(workspace).some((item) => item.active)) return null;
      if (this.deferIfBudgetExhausted(workspace, agentId, work, maxTurns)) return null;
      if (work.taskId) {
        const claimed = this.db.prepare("UPDATE runner_tasks SET status = 'running' WHERE id = ? AND workspace = ? AND agent_id = ? AND status = 'queued'")
          .run(work.taskId, workspace, agentId);
        if (claimed.changes !== 1) return null;
      }
      const active: ActiveRun = { ...work, id: ulid(), startedAt: Date.now(), childPid: null };
      this.db.prepare("UPDATE runner_agents SET active = ?, output = '' WHERE workspace = ? AND agent_id = ?")
        .run(JSON.stringify(active), workspace, agentId);
      if (work.threadId) this.addBudget(workspace, work.threadId);
      this.db.prepare(`INSERT INTO runner_rotation (workspace, last_agent_id) VALUES (?, ?)
        ON CONFLICT(workspace) DO UPDATE SET last_agent_id = excluded.last_agent_id`).run(workspace, agentId);
      return active;
    }).immediate();
  }

  setSession(workspace: string, agentId: string, runId: string, sessionId: string): void {
    if (this.closed) return;
    if (!sessionId.trim()) throw new Error("Provider returned an empty session ID.");
    this.db.transaction(() => {
      if (this.getAgent(workspace, agentId).active?.id !== runId) return;
      this.db.prepare("UPDATE runner_agents SET session_id = ? WHERE workspace = ? AND agent_id = ?").run(sessionId, workspace, agentId);
    }).immediate();
  }

  setChild(workspace: string, agentId: string, runId: string, pid: number): void {
    if (this.closed) return;
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Provider returned an invalid child PID.");
    this.db.transaction(() => {
      const active = this.getAgent(workspace, agentId).active;
      if (active?.id !== runId) return;
      active.childPid = pid;
      active.childIdentity = captureProcessIdentity(pid);
      this.db.prepare("UPDATE runner_agents SET active = ? WHERE workspace = ? AND agent_id = ?").run(JSON.stringify(active), workspace, agentId);
    }).immediate();
  }

  finishRun(workspace: string, agentId: string, runId: string, result: {
    status: "completed" | "blocked"; output: string; reason?: string; keepActive?: boolean;
  }): void {
    this.db.transaction(() => {
      const active = this.getAgent(workspace, agentId).active;
      if (active?.id !== runId) return;
      this.db.prepare(`UPDATE runner_agents SET output = ?, blocked_reason = ?, active = ?, cursor = MAX(cursor, ?)
        WHERE workspace = ? AND agent_id = ?`).run(
        result.output.slice(-OUTPUT_LIMIT), result.status === "completed" ? null : result.reason ?? "Invocation did not complete.",
        result.keepActive ? JSON.stringify(active) : null,
        result.status === "completed" ? active.eventSeq ?? 0 : 0, workspace, agentId,
      );
      if (active.taskId) this.db.prepare("UPDATE runner_tasks SET status = ? WHERE id = ?").run(result.status, active.taskId);
      if (result.status === "completed" && active.deferredThread && active.threadId && active.eventSeq !== null) {
        this.advanceDeferredThread(workspace, agentId, active.threadId, active.eventSeq);
      }
    }).immediate();
  }

  /** A cancelled adapter may settle after tick returns; its durable evidence stays blocked. */
  clearSettledRun(workspace: string, agentId: string, runId: string): void {
    if (this.closed) return;
    this.db.transaction(() => {
      const agent = this.getAgent(workspace, agentId);
      if (!agent.blockedReason || agent.active?.id !== runId) return;
      this.childIdentityChecks.set(runId, Date.now());
      if (agent.active.childPid !== null && processMatchesIdentity(agent.active.childPid, agent.active.childIdentity)) return;
      this.db.prepare("UPDATE runner_agents SET active = NULL WHERE workspace = ? AND agent_id = ?").run(workspace, agentId);
      this.childIdentityChecks.delete(runId);
    }).immediate();
  }

  reapExitedChildren(workspace: string): void {
    for (const agent of this.agents(workspace)) {
      if (agent.blockedReason && agent.active?.childPid !== null && agent.active?.childPid !== undefined) {
        // Keep each poll cheap when a child is slow to exit. A confirmed exit
        // clears immediately; birth probes for a live PID are less frequent.
        const checkedAt = this.childIdentityChecks.get(agent.active.id);
        if (checkedAt !== undefined && Date.now() - checkedAt < CHILD_IDENTITY_CHECK_MS && processAlive(agent.active.childPid)) continue;
        this.clearSettledRun(workspace, agent.agentId, agent.active.id);
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.childIdentityChecks.clear();
    this.db.close();
  }
}
