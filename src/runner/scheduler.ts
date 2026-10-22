import type { Store, ThreadSummary } from "../store.js";
import type { HubEvent } from "../types.js";
import { buildPrompt, type PromptWork } from "./prompt.js";
import { RunnerState, type ActiveRun, type QueuedTask } from "./state.js";
import { processMatchesIdentity } from "./process-identity.js";
import type { AgentAdapter, AgentResult, Provider, RunnerAgent, RunnerConfig } from "./types.js";

const EVENT_BATCH_SIZE = 200;
const CLEANUP_GRACE_MS = 20_000;
interface Delivery extends PromptWork {
  task?: QueuedTask;
  thread?: ThreadSummary;
  eventSeq: number | null;
  eventStartSeq?: number;
  deferredThread?: boolean;
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
          eventStartSeq: delivery.eventStartSeq,
          deferredThread: delivery.deferredThread,
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

  private threadEvents(threadId: string): HubEvent[] {
    const events: HubEvent[] = [];
    let afterSeq = 0;
    for (;;) {
      const page = this.store.listAllEvents({ workspaceId: this.workspaceId, threadId, afterSeq, limit: EVENT_BATCH_SIZE });
      events.push(...page.events);
      if (!page.has_more) return events;
      afterSeq = page.event_cursor;
    }
  }

  private actionable(agent: RunnerAgent, event: HubEvent, summary: ThreadSummary, history: HubEvent[]): boolean {
    if (event.actor_id === agent.id || summary.thread.status !== "open") return false;
    const revision = summary.latest_revision.id;
    if (event.type === "request_created") {
      return event.request?.status === "open" && event.request.assignee_id === agent.id && event.request.target_revision_id === revision;
    }
    if (event.type === "request_completed") {
      const request = event.request;
      if (summary.thread.created_by !== agent.id || request?.status !== "completed" || request.target_revision_id !== revision) return false;
      const verdict = request.completed_by_message_id ? this.store.getMessage(request.completed_by_message_id) : null;
      if (verdict?.verdict === "request_changes") return true;
      const required = summary.current_round_requests.filter(item => item.target_revision_id === revision);
      if (!required.length || required.some(item => item.status !== "completed")) return false;
      // request_completed is the canonical wakeup for a linked verdict. Only
      // the final required completion wakes the author, even if earlier
      // approvals and this one are separated by another thread's events.
      return history.filter(item => item.type === "request_completed" && required.some(request => request.id === item.ref_id)).at(-1)?.seq === event.seq;
    }
    if (event.type !== "message_posted" || !event.message || event.message.kind === "system") return false;
    const message = event.message;
    if (message.revision_id !== null && message.revision_id !== revision) return false;
    if (message.response_request_id) {
      const request = this.store.getRequest(message.response_request_id);
      if (request.target_revision_id !== revision || request.status === "superseded" || request.status === "cancelled") return false;
    }
    if (message.kind === "verdict") {
      return !message.response_request_id && summary.thread.created_by === agent.id && message.verdict === "request_changes";
    }
    if (["question", "objection", "proposal"].includes(message.kind) || message.recipients?.includes(agent.id)) return true;
    if (message.reply_to) {
      const parent = this.store.getMessage(message.reply_to);
      if (parent.sender_id === agent.id && (parent.revision_id === null || parent.revision_id === revision)) return true;
    }
    // Ordinary author context is a reply when this reviewer has an outstanding
    // question on its still-open request. FYI comments after a verdict are not.
    if (message.sender_id !== summary.thread.created_by) return false;
    const pending = summary.current_round_requests.find(request => request.assignee_id === agent.id && request.status === "open" && request.target_revision_id === revision);
    if (!pending) return false;
    const requestedAt = history.find(item => item.type === "request_created" && item.ref_id === pending.id)?.seq ?? 0;
    return history.some(item => item.seq > requestedAt && item.seq < event.seq && item.actor_id === agent.id &&
      item.message && ["question", "objection"].includes(item.message.kind) &&
      (item.message.revision_id === null || item.message.revision_id === revision));
  }

  private nextDelivery(agent: RunnerAgent): Delivery | null {
    const task = this.state.pendingTask(this.workspace, agent.id);
    if (task) return { task, eventSeq: null };
    const histories = new Map<string, HubEvent[]>();
    const history = (id: string) => {
      if (!histories.has(id)) histories.set(id, this.threadEvents(id));
      return histories.get(id)!;
    };
    for (const parked of this.state.deferredThreads(this.workspace).filter(item => item.agentId === agent.id && !item.blockedReason)) {
      const summary = this.store.threadSummary(parked.threadId);
      const page = this.store.listVisibleEvents(agent.id, { workspaceId: this.workspaceId, threadId: parked.threadId, afterSeq: parked.fromSeq - 1, includeOwn: true, limit: EVENT_BATCH_SIZE });
      const covered = page.events.filter(event => event.seq <= parked.throughSeq);
      const throughSeq = page.has_more && page.event_cursor < parked.throughSeq ? page.event_cursor : parked.throughSeq;
      const events = covered.filter(event => this.actionable(agent, event, summary, history(parked.threadId)));
      if (!events.length) {
        this.state.advanceDeferredThread(this.workspace, agent.id, parked.threadId, throughSeq);
        continue;
      }
      const delivery = { events, thread: summary, eventStartSeq: parked.fromSeq, eventSeq: throughSeq, deferredThread: true };
      if (this.state.deferIfBudgetExhausted(this.workspace, agent.id, { ...delivery, taskId: null, threadId: parked.threadId }, this.config.maxTurnsPerThread)) continue;
      return delivery;
    }
    const cursor = this.state.getAgent(this.workspace, agent.id).cursor;
    const page = this.store.listVisibleEvents(agent.id, { workspaceId: this.workspaceId, afterSeq: cursor, includeOwn: true, limit: EVENT_BATCH_SIZE });
    for (let index = 0; index < page.events.length; index++) {
      const event = page.events[index]!;
      const summary = this.store.threadSummary(event.thread_id);
      if (!this.actionable(agent, event, summary, history(event.thread_id))) {
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
        if (this.actionable(agent, candidate, summary, history(event.thread_id))) events.push(candidate);
        index = next;
      }
      const delivery = { events, thread: summary, eventStartSeq: event.seq, eventSeq };
      if (this.state.deferIfBudgetExhausted(this.workspace, agent.id, { ...delivery, taskId: null, threadId: event.thread_id }, this.config.maxTurnsPerThread)) continue;
      return delivery;
    }
    return null;
  }

  private progress(agentId: string, afterSeq: number, threadId: string | null): { threads: Set<string>; events: HubEvent[] } {
    const threads = new Set<string>();
    const events: HubEvent[] = [];
    let after = afterSeq;
    for (;;) {
      const page = this.store.listAllEvents({ workspaceId: this.workspaceId, threadId: threadId ?? undefined, afterSeq: after, limit: EVENT_BATCH_SIZE });
      for (const event of page.events) {
        if (event.actor_id === agentId && ["message_posted", "revision_submitted", "thread_closed"].includes(event.type)) {
          threads.add(event.thread_id);
          events.push(event);
        }
      }
      if (!page.has_more) return { threads, events };
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
      const child = this.state.getAgent(this.workspace, agent.id).active;
      const liveChild = child?.childPid !== null && child?.childPid !== undefined && processMatchesIdentity(child.childPid, child.childIdentity);
      const madeProgress = this.progress(agent.id, beforeSeq, active.threadId);
      let reason = cancellation ?? (result.status === "completed" ? undefined : result.reason ?? `Provider ${result.status}.`);
      const current = delivery.thread ? this.store.threadSummary(delivery.thread.thread.id) : undefined;
      const obsolete = current && (current.thread.status !== "open" || current.latest_revision.id !== delivery.thread!.latest_revision.id ||
        delivery.events?.every(event => !this.actionable(agent, event, current, this.threadEvents(current.thread.id))));
      const assigned = delivery.thread?.current_round_requests.filter(request => request.assignee_id === agent.id && request.status === "open" && request.target_revision_id === delivery.thread!.latest_revision.id) ?? [];
      if (!reason && !obsolete && madeProgress.threads.size === 0) reason = "No meaningful Collidr progress in the target workspace/thread; inspect and retry explicitly.";
      if (!reason && !obsolete && assigned.length) {
        const completed = assigned.every(request => this.store.getRequest(request.id).status === "completed");
        const asked = madeProgress.events.some(event => event.message && ["question", "objection"].includes(event.message.kind) &&
          (event.message.revision_id === null || event.message.revision_id === current!.latest_revision.id) &&
          (event.message.recipients === null || event.message.recipients.includes(current!.thread.created_by)));
        if (!completed && !asked) reason = "Assigned review request remains open: complete it with a verdict or post a meaningful question/objection; partial review notes do not deliver the request.";
      }
      if (!reason && liveChild) reason = "Provider returned while its child process is still running.";
      if (delivery.task) for (const threadId of madeProgress.threads) this.state.addBudget(this.workspace, threadId);
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
