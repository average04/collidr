import type { Store, ThreadSummary } from "../store.js";
import type { HubEvent } from "../types.js";
import { buildPrompt, type PromptWork } from "./prompt.js";
import { processAlive, RunnerState, type ActiveRun, type QueuedTask } from "./state.js";
import type { AgentAdapter, AgentResult, Provider, RunnerAgent, RunnerConfig } from "./types.js";

const EVENT_BATCH_SIZE = 200;
const CLEANUP_GRACE_MS = 20_000;
interface Delivery extends PromptWork {
  task?: QueuedTask;
  thread?: ThreadSummary;
  eventSeq: number | null;
}

/** Runs at most one turn per tick; lease ownership and polling belong to the supervisor. */
export class RunnerScheduler {
  readonly workspace: string;
  readonly workspaceId: string;
  private busy = false;

  constructor(
    private readonly config: RunnerConfig,
    private readonly store: Store,
    private readonly state: RunnerState,
    private readonly adapters: Record<Provider, AgentAdapter>,
    private readonly options: { log?: (message: string) => void } = {},
  ) {
    this.workspace = config.workspace;
    this.workspaceId = store.ensureWorkspace(this.workspace).id;
    for (const agent of config.agents) {
      store.register({ participantId: agent.id, client: `${agent.provider}-managed`, model: agent.model, role: "agent", reuseSessionWithinMs: 60_000 });
      state.ensureAgent(this.workspace, agent.id, agent.provider);
    }
  }

  async tick(signal?: AbortSignal): Promise<boolean> {
    if (this.busy || signal?.aborted) return false;
    this.busy = true;
    try {
      this.state.reapExitedChildren(this.workspace);
      const agents = this.config.agents;
      const lastIndex = agents.findIndex((agent) => agent.id === this.state.lastAgent(this.workspace));
      for (let offset = 1; offset <= agents.length; offset++) {
        if (signal?.aborted) return false;
        const agent = agents[(lastIndex + offset) % agents.length]!;
        if (this.state.getAgent(this.workspace, agent.id).blockedReason) continue;
        const delivery = this.nextDelivery(agent);
        if (!delivery) continue;
        const active = this.state.beginRun(this.workspace, agent.id, {
          taskId: delivery.task?.id ?? null,
          threadId: delivery.thread?.thread.id ?? null,
          eventSeq: delivery.eventSeq,
        }, this.config.maxTurnsPerThread);
        if (!active) continue;
        await this.invoke(agent, active, delivery, signal);
        return true;
      }
      return false;
    } finally {
      this.busy = false;
    }
  }

  private actionable(agent: RunnerAgent, event: HubEvent, summary: ThreadSummary): boolean {
    if (event.actor_id === agent.id || summary.thread.status !== "open") return false;
    const revision = summary.latest_revision.id;
    if (event.type === "request_created") {
      return event.request?.status === "open" && event.request.assignee_id === agent.id && event.request.target_revision_id === revision;
    }
    if (event.type === "request_completed") {
      return summary.thread.created_by === agent.id && event.request?.status === "completed" && event.request.target_revision_id === revision;
    }
    if (event.type !== "message_posted" || !event.message || event.message.kind === "system") return false;
    const message = event.message;
    if (message.revision_id !== null && message.revision_id !== revision) return false;
    if (message.response_request_id) {
      const request = this.store.getRequest(message.response_request_id);
      if (request.target_revision_id !== revision || request.status === "superseded" || request.status === "cancelled") return false;
    }
    return message.kind !== "verdict" || summary.thread.created_by === agent.id;
  }

  private nextDelivery(agent: RunnerAgent): Delivery | null {
    const task = this.state.pendingTask(this.workspace, agent.id);
    if (task) return { task, eventSeq: null };
    const cursor = this.state.getAgent(this.workspace, agent.id).cursor;
    const page = this.store.listVisibleEvents(agent.id, { workspaceId: this.workspaceId, afterSeq: cursor, includeOwn: true, limit: EVENT_BATCH_SIZE });
    for (let index = 0; index < page.events.length; index++) {
      const event = page.events[index]!;
      const summary = this.store.threadSummary(event.thread_id);
      if (!this.actionable(agent, event, summary)) {
        this.state.advance(this.workspace, agent.id, event.seq);
        continue;
      }
      // Consume only this contiguous thread segment. A later event for this same
      // thread cannot jump over pending work on a different interleaved thread.
      const events = [event];
      let eventSeq = event.seq;
      for (let next = index + 1; next < page.events.length; next++) {
        const candidate = page.events[next]!;
        if (candidate.thread_id !== event.thread_id) break;
        eventSeq = candidate.seq;
        if (this.actionable(agent, candidate, summary)) events.push(candidate);
      }
      return { events, thread: summary, eventSeq };
    }
    return null;
  }

  private progress(agentId: string, afterSeq: number, threadId: string | null): Set<string> {
    const threads = new Set<string>();
    let after = afterSeq;
    for (;;) {
      const page = this.store.listAllEvents({ workspaceId: this.workspaceId, threadId: threadId ?? undefined, afterSeq: after, limit: EVENT_BATCH_SIZE });
      for (const event of page.events) {
        if (event.actor_id === agentId && ["message_posted", "revision_submitted", "thread_closed"].includes(event.type)) threads.add(event.thread_id);
      }
      if (!page.has_more) return threads;
      after = page.event_cursor;
    }
  }

  private async invoke(agent: RunnerAgent, active: ActiveRun, delivery: Delivery, externalSignal?: AbortSignal): Promise<void> {
    const controller = new AbortController();
    let cancellation: string | null = null;
    let settled = false;
    let result: AgentResult | undefined;
    let adapterPromise: Promise<AgentResult> | undefined;
    let cancelResolve: ((value: AgentResult) => void) | undefined;
    const cancelled = new Promise<AgentResult>((resolve) => { cancelResolve = resolve; });
    const cancel = (reason: string) => {
      if (cancellation) return;
      cancellation = reason;
      controller.abort(new Error(reason));
      cancelResolve!({ status: "blocked", reason, output: "" });
    };
    const abort = () => cancel("Invocation aborted by supervisor stop.");
    externalSignal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => cancel(`Invocation timed out after ${this.config.turnTimeoutMs} ms.`), this.config.turnTimeoutMs);
    const beforeSeq = this.store.maxSeq();
    try {
      this.options.log?.(`Starting ${agent.id} (${active.id})${active.threadId ? ` for thread ${active.threadId}` : ` for task ${active.taskId}`}.`);
      if (externalSignal?.aborted) abort();
      if (cancellation) {
        result = { status: "blocked", reason: cancellation, output: "" };
      } else {
        adapterPromise = Promise.resolve().then(() => this.adapters[agent.provider].run({
          agent, workspace: this.workspace, database: this.config.database, cliPath: this.config.cliPath,
          prompt: buildPrompt(this.config, agent, delivery),
          sessionId: this.state.getAgent(this.workspace, agent.id).sessionId,
          signal: controller.signal,
          onSession: (id) => this.state.setSession(this.workspace, agent.id, active.id, id),
          onSpawn: (pid) => this.state.setChild(this.workspace, agent.id, active.id, pid),
          log: this.options.log,
        })).then((value) => { settled = true; return value; }, (error: unknown) => {
          settled = true;
          return { status: "failed" as const, output: "", reason: error instanceof Error ? error.message : String(error) };
        });
        result = await Promise.race([adapterPromise, cancelled]);
        if (cancellation && !settled) {
          // Provider adapters own process-tree termination. Give their bounded
          // cleanup time to finish before the CLI releases its workspace lease.
          let cleanupTimer: NodeJS.Timeout | undefined;
          try {
            result = await Promise.race([
              adapterPromise,
              new Promise<AgentResult>((resolve) => { cleanupTimer = setTimeout(() => resolve(result!), CLEANUP_GRACE_MS); }),
            ]);
          } finally { clearTimeout(cleanupTimer); }
        }
      }
      if (result.sessionId) this.state.setSession(this.workspace, agent.id, active.id, result.sessionId);
      const childPid = this.state.getAgent(this.workspace, agent.id).active?.childPid;
      const liveChild = childPid !== null && childPid !== undefined && processAlive(childPid);
      const madeProgress = this.progress(agent.id, beforeSeq, active.threadId);
      let reason = cancellation ?? (result.status === "completed" ? undefined : result.reason ?? `Provider ${result.status}.`);
      if (!reason && madeProgress.size === 0) reason = "No meaningful Collidr progress in the target workspace/thread; inspect and retry explicitly.";
      if (!reason && liveChild) reason = "Provider returned while its child process is still running.";
      if (delivery.task) for (const threadId of madeProgress) this.state.addBudget(this.workspace, threadId);
      this.state.finishRun(this.workspace, agent.id, active.id, {
        status: reason ? "blocked" : "completed", reason,
        output: result.output,
        keepActive: !settled && adapterPromise !== undefined || liveChild,
      });
      this.options.log?.(`${reason ? "Blocked" : "Completed"} ${agent.id} (${active.id})${reason ? `: ${reason}` : "."}`);
    } catch (error) {
      controller.abort(error);
      this.state.finishRun(this.workspace, agent.id, active.id, {
        status: "blocked", reason: error instanceof Error ? error.message : String(error), output: result?.output ?? "",
        keepActive: adapterPromise !== undefined && !settled,
      });
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abort);
      if (adapterPromise) {
        void adapterPromise.then(() => this.state.clearSettledRun(this.workspace, agent.id, active.id)).catch(() => {
          // Persistence errors leave active evidence for conservative crash recovery.
        });
      }
    }
  }
}
