import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ulid } from "ulid";
import type { Provider } from "./types.js";

export interface RunWork {
  taskId: string | null;
  threadId: string | null;
  eventSeq: number | null;
}

export interface ActiveRun extends RunWork {
  id: string;
  startedAt: number;
  childPid: number | null;
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
  heartbeatAt: number;
  stopRequested: boolean;
}

export interface RunnerStatus {
  workspace: string;
  lease: Lease | null;
  agents: AgentState[];
  tasks: QueuedTask[];
  budgets: { threadId: string; invocations: number }[];
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

/** EPERM still means a process exists; uncertainty must never permit overlap. */
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

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

  constructor(database: string) {
    this.file = `${database}.runner.db`;
    mkdirSync(dirname(this.file), { recursive: true });
    this.db = new Database(this.file);
    try {
      this.db.pragma("busy_timeout = 5000");
      this.db.transaction(() => {
        const version = this.db.pragma("user_version", { simple: true }) as number;
        if (version > 1) throw new Error(`Runner state schema version ${version} is newer than supported version 1.`);
        if (version === 1) return;
        this.db.exec(`
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
        this.db.pragma("user_version = 1");
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
        if (lease.owner === owner && lease.pid === pid) {
          this.heartbeat(workspace, owner);
          return true;
        }
        if (processAlive(lease.pid) || Date.now() - lease.heartbeatAt < LEASE_TIMEOUT_MS) return false;
      }
      const active = this.agents(workspace).filter((agent) => agent.active !== null);
      if (active.some((agent) => agent.active!.childPid !== null && processAlive(agent.active!.childPid!))) return false;
      for (const agent of active) {
        this.finishRun(workspace, agent.agentId, agent.active!.id, {
          status: "blocked", output: agent.output,
          reason: agent.blockedReason ?? "Interrupted runner invocation; inspect Collidr progress before retrying.",
        });
      }
      this.db.prepare(`INSERT INTO runner_leases (workspace, owner, pid, heartbeat_at, stop_requested)
        VALUES (?, ?, ?, ?, 0) ON CONFLICT(workspace) DO UPDATE SET
        owner = excluded.owner, pid = excluded.pid, heartbeat_at = excluded.heartbeat_at, stop_requested = 0`)
        .run(workspace, owner, pid, Date.now());
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
    const row = this.db.prepare("SELECT owner, pid, heartbeat_at, stop_requested FROM runner_leases WHERE workspace = ?")
      .get(workspace) as { owner: string; pid: number; heartbeat_at: number; stop_requested: number } | undefined;
    return row ? { owner: row.owner, pid: row.pid, heartbeatAt: row.heartbeat_at, stopRequested: row.stop_requested !== 0 } : null;
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
      budgets: this.db.prepare("SELECT thread_id AS threadId, invocations FROM runner_budgets WHERE workspace = ? ORDER BY thread_id")
        .all(workspace) as RunnerStatus["budgets"],
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

  retry(workspace: string, agentId: string): void {
    this.db.transaction(() => {
      const agent = this.getAgent(workspace, agentId);
      if (agent.active) throw new Error(`Agent ${agentId} still has an active invocation; wait for its child to exit or restart the supervisor.`);
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
      if (work.threadId && this.getBudget(workspace, work.threadId) >= maxTurns) {
        this.db.prepare("UPDATE runner_agents SET blocked_reason = ? WHERE workspace = ? AND agent_id = ?")
          .run(`Thread ${work.threadId} reached its ${maxTurns}-invocation budget.`, workspace, agentId);
        return null;
      }
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
    }).immediate();
  }

  /** A cancelled adapter may settle after tick returns; its durable evidence stays blocked. */
  clearSettledRun(workspace: string, agentId: string, runId: string): void {
    if (this.closed) return;
    this.db.transaction(() => {
      const agent = this.getAgent(workspace, agentId);
      if (!agent.blockedReason || agent.active?.id !== runId) return;
      if (agent.active.childPid !== null && processAlive(agent.active.childPid)) return;
      this.db.prepare("UPDATE runner_agents SET active = NULL WHERE workspace = ? AND agent_id = ?").run(workspace, agentId);
    }).immediate();
  }

  reapExitedChildren(workspace: string): void {
    for (const agent of this.agents(workspace)) {
      if (agent.blockedReason && agent.active?.childPid !== null && agent.active?.childPid !== undefined) {
        this.clearSettledRun(workspace, agent.agentId, agent.active.id);
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
