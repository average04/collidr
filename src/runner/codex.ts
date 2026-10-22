import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnAgent, terminateChild } from "./process.js";
import type { AgentAdapter, AgentContext, AgentResult } from "./types.js";

const LINE_LIMIT = 1024 * 1024;
const OUTPUT_LIMIT = 512 * 1024;
const STDERR_LIMIT = 16 * 1024;
const COLLIDR_TOOLS = ["register", "whoami", "list_threads", "open_thread", "submit_revision", "read_revision", "post", "read_thread", "inbox", "wait_for_messages", "ack", "resolve"];
type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid Codex protocol object");
  return value as ObjectValue;
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid Codex ${name}`);
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cancelled(signal: AbortSignal): string {
  return signal.reason ? `Codex run cancelled: ${message(signal.reason)}` : "Codex run cancelled";
}

function requestDiagnostic(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+/gi, "[redacted URL]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password|token|authorization)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[redacted]")
    .replace(/\b(?:sk|ghp|gho|ghu|ghs|github_pat)[-_][a-z0-9_-]+\b/gi, "[redacted]")
    .replace(/[a-z0-9+/_=-]{48,}/gi, "[redacted]")
    .replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function blockedRequestReason(method: string, params: ObjectValue): string {
  const server = requestDiagnostic(params.serverName, 120);
  const reason = requestDiagnostic(params.reason, 300);
  const detail = requestDiagnostic(params.message, 800);
  return [`Codex requires user action: ${requestDiagnostic(method, 120)}`, server ? `server: ${server}` : "", reason, detail].filter(Boolean).join("; ");
}

function cappedPermissions(value: unknown): ObjectValue {
  const config = object(value);
  const sandbox = config.sandbox_mode;
  if (sandbox !== undefined && sandbox !== null && (typeof sandbox !== "string" || !["read-only", "workspace-write", "danger-full-access"].includes(sandbox))) {
    throw new Error("Unsupported Codex sandbox configuration");
  }
  const policy = config.approval_policy;
  let approvalPolicy: unknown = "on-request";
  if (policy === "untrusted") approvalPolicy = policy;
  else if (policy !== undefined && policy !== null && policy !== "on-request" && policy !== "never") {
    const record = object(policy);
    const granular = object(record.granular);
    const keys = ["sandbox_approval", "rules", "skill_approval", "request_permissions", "mcp_elicitations"];
    if (Object.keys(record).length !== 1 || Object.keys(granular).length !== keys.length || keys.some(key => typeof granular[key] !== "boolean")) {
      throw new Error("Unsupported Codex granular approval configuration");
    }
    approvalPolicy = { granular };
  }
  return { sandbox: sandbox === "workspace-write" || sandbox === "danger-full-access" ? "workspace-write" : "read-only", approvalPolicy, approvalsReviewer: "user" };
}

function argumentsFor(context: AgentContext): string[] {
  // Values are TOML strings/arrays passed directly as argv, never through a shell.
  const overrides = [
    `mcp_servers.collidr.command=${JSON.stringify(process.execPath)}`,
    `mcp_servers.collidr.args=${JSON.stringify([context.cliPath, "serve"])}`,
    `mcp_servers.collidr.cwd=${JSON.stringify(context.workspace)}`,
    `mcp_servers.collidr.env.COLLIDR_PARTICIPANT=${JSON.stringify(context.agent.id)}`,
    `mcp_servers.collidr.env.COLLIDR_WORKSPACE=${JSON.stringify(context.workspace)}`,
    `mcp_servers.collidr.env.COLLIDR_DB=${JSON.stringify(context.database)}`,
    'mcp_servers.collidr.env.COLLIDR_CLIENT="codex-runner"',
    "mcp_servers.collidr.required=true",
  ];
  // Expand only today's known Collidr tools; a wildcard must not approve future
  // tools or alter another server's approvals or configured disabled tools.
  const allowed = new Set(context.agent.allowedTools);
  for (const name of COLLIDR_TOOLS) {
    if (allowed.has("mcp__collidr__*") || allowed.has(`mcp__collidr__${name}`)) {
      overrides.push(`mcp_servers.collidr.tools.${name}.approval_mode="approve"`);
    }
  }
  return [...context.agent.args, "app-server", "--listen", "stdio://", ...overrides.flatMap(value => ["-c", value])];
}

export class CodexAdapter implements AgentAdapter {
  async run(context: AgentContext): Promise<AgentResult> {
    if (context.signal.aborted) return { status: "blocked", output: "", reason: cancelled(context.signal) };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnAgent(context.agent.command, argumentsFor(context), { cwd: context.workspace });
    } catch (error) {
      return { status: "failed", output: "", reason: message(error) };
    }

    let stderr = "";
    let abortListener: (() => void) | undefined;
    let interruptTimer: NodeJS.Timeout | undefined;
    let result: AgentResult = { status: "failed", output: "", reason: "Codex did not produce a terminal result" };
    try {
      result = await new Promise<AgentResult>(resolve => {
        let finished = false;
        let buffer = "";
        let phase: "initialize" | "config" | "thread" | "turn" = "initialize";
        let sessionId = context.sessionId ?? undefined;
        let turnId: string | undefined;
        let turnAcknowledged = false;
        let blockedReason: string | undefined;
        let interrupted = false;
        let outputLength = 0;
        let outputItems = 0;
        const messagesByTurn = new Map<string, Map<string, string>>();
        const earlyCompletions = new Map<string, ObjectValue>();

        const finish = (status: AgentResult["status"], reason?: string) => {
          if (finished) return;
          finished = true;
          clearTimeout(interruptTimer);
          if (blockedReason) { status = "blocked"; reason = blockedReason; }
          const diagnostics = stderr.trim();
          resolve({ status, sessionId, output: [...(messagesByTurn.get(turnId ?? "")?.values() ?? [])].join("\n"),
            ...(reason ? { reason: `${reason}${diagnostics ? `: ${diagnostics}` : ""}` } : {}) });
        };
        const fail = (error: unknown) => finish("failed", message(error));
        const send = (value: ObjectValue) => {
          if (!finished) child.stdin.write(JSON.stringify(value) + "\n");
        };
        const interrupt = () => {
          if (!interrupted && sessionId && turnId) {
            interrupted = true;
            send({ id: 4, method: "turn/interrupt", params: { threadId: sessionId, turnId } });
          }
        };
        const block = (reason: string) => {
          if (finished || blockedReason) return;
          blockedReason = reason;
          if (phase !== "turn") { finish("blocked", reason); return; }
          // Request cancellation first; then bound how long an unresponsive server
          // can delay cleanup. No approval response or permission grant is sent.
          interrupt();
          interruptTimer = setTimeout(() => finish("blocked", reason), 1000);
        };
        const setText = (sourceTurnId: string, id: string, text: string, append: boolean) => {
          if (turnAcknowledged && sourceTurnId !== turnId) return;
          let messages = messagesByTurn.get(sourceTurnId);
          if (!messages) {
            if (messagesByTurn.size >= 8) throw new Error("Codex early output limit exceeded");
            messages = new Map();
            messagesByTurn.set(sourceTurnId, messages);
          }
          const previous = messages.get(id) ?? "";
          const next = append ? previous + text : text;
          const length = outputLength - previous.length + next.length;
          if (length > OUTPUT_LIMIT || (!messages.has(id) && outputItems >= 1024)) throw new Error("Codex output limit exceeded");
          if (!messages.has(id)) outputItems++;
          messages.set(id, next);
          outputLength = length;
        };
        const complete = (turn: ObjectValue) => {
          if (blockedReason) { finish("blocked", blockedReason); return; }
          if (!Array.isArray(turn.items)) throw new Error("Invalid Codex turn items");
          for (const value of turn.items) {
            const item = object(value);
            if (item.type === "agentMessage") {
              if (typeof item.text !== "string") throw new Error("Invalid Codex agent message text");
              setText(identifier(turn.id, "turn ID"), identifier(item.id, "item ID"), item.text, false);
            }
          }
          if (turn.status === "completed") finish("completed");
          else if (turn.status === "interrupted") finish("blocked", "Codex turn was interrupted");
          else if (turn.status === "failed") {
            const detail = turn.error && object(turn.error).message;
            finish("failed", typeof detail === "string" ? detail : "Codex turn failed");
          } else throw new Error(`Invalid Codex terminal status: ${String(turn.status)}`);
        };

        const receive = (value: unknown) => {
          const frame = object(value);
          // Server request IDs belong to a separate namespace and may collide
          // with a pending client request. Never handle these as RPC responses.
          if (typeof frame.method === "string" && "id" in frame) {
            const params = object(frame.params ?? {});
            if (typeof params.turnId === "string" && params.threadId === sessionId) turnId = params.turnId;
            block(blockedRequestReason(frame.method, params));
            return;
          }
          if ("id" in frame) {
            if (frame.error !== undefined) {
              const error = object(frame.error);
              throw new Error(`Codex RPC error: ${typeof error.message === "string" ? error.message : "unknown error"}`);
            }
            const result = object(frame.result);
            if (frame.id === 1 && phase === "initialize") {
              send({ method: "initialized", params: {} });
              phase = "config";
              send({ id: 5, method: "config/read", params: { includeLayers: false, cwd: context.workspace } });
            } else if (frame.id === 5 && phase === "config") {
              const permissions = cappedPermissions(result.config);
              phase = "thread";
              send({ id: 2, method: context.sessionId ? "thread/resume" : "thread/start", params: {
                ...(context.sessionId ? { threadId: context.sessionId, excludeTurns: true } : { ephemeral: false }),
                cwd: context.workspace, ...permissions,
                developerInstructions: context.agent.instructions,
                ...(context.agent.model ? { model: context.agent.model } : {}),
              } });
            } else if (frame.id === 2 && phase === "thread") {
              const id = identifier(object(result.thread).id, "thread ID");
              if (context.sessionId && id !== context.sessionId) throw new Error("Codex resumed a different session");
              context.onSession(id);
              sessionId = id;
              phase = "turn";
              send({ id: 3, method: "turn/start", params: {
                threadId: id, input: [{ type: "text", text: context.prompt, text_elements: [] }],
              } });
            } else if (frame.id === 3 && phase === "turn") {
              const turn = object(result.turn);
              turnId = identifier(turn.id, "turn ID");
              turnAcknowledged = true;
              for (const [id, messages] of messagesByTurn) {
                if (id === turnId) continue;
                for (const text of messages.values()) outputLength -= text.length;
                outputItems -= messages.size;
                messagesByTurn.delete(id);
              }
              if (blockedReason) interrupt();
              const terminal = earlyCompletions.get(turnId);
              earlyCompletions.clear();
              if (terminal) complete(terminal);
            }
            return;
          }
          if (typeof frame.method !== "string") throw new Error("Invalid Codex protocol message");
          const params = object(frame.params ?? {});
          if (frame.method === "error" && params.willRetry !== true) {
            const error = object(params.error);
            throw new Error(typeof error.message === "string" ? error.message : "Codex provider error");
          }
          if (params.threadId !== sessionId || phase !== "turn") return;
          if (frame.method === "turn/started") {
            if (!turnAcknowledged) turnId = identifier(object(params.turn).id, "turn ID");
            if (blockedReason) interrupt();
          } else if (frame.method === "turn/completed") {
            const turn = object(params.turn);
            const id = identifier(turn.id, "turn ID");
            if ((turnAcknowledged || blockedReason) && id === turnId) complete(turn);
            else if (!turnAcknowledged) {
              if (earlyCompletions.size >= 8) throw new Error("Codex early completion limit exceeded");
              earlyCompletions.set(id, turn);
            }
          } else if (frame.method === "item/agentMessage/delta") {
            if (typeof params.delta !== "string") throw new Error("Invalid Codex message delta");
            setText(identifier(params.turnId, "turn ID"), identifier(params.itemId, "item ID"), params.delta, true);
          } else if (frame.method === "item/completed") {
            const item = object(params.item);
            if (item.type === "agentMessage") {
              if (typeof item.text !== "string") throw new Error("Invalid Codex agent message text");
              setText(identifier(params.turnId, "turn ID"), identifier(item.id, "item ID"), item.text, false);
            }
          }
        };

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          if (finished) return;
          try {
            buffer += chunk;
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              if (newline > LINE_LIMIT) throw new Error("Codex protocol line limit exceeded");
              const line = buffer.slice(0, newline).trim();
              buffer = buffer.slice(newline + 1);
              if (line) {
                let frame: unknown;
                try { frame = JSON.parse(line); } catch { throw new Error("Invalid JSON from Codex app-server"); }
                receive(frame);
              }
              if (finished) { buffer = ""; return; }
            }
            if (buffer.length > LINE_LIMIT) throw new Error("Codex protocol line limit exceeded");
          } catch (error) { fail(error); }
        });
        child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-STDERR_LIMIT); });
        child.on("error", fail);
        child.stdin.on("error", fail);
        child.stdout.on("error", fail);
        child.stderr.on("error", fail);
        child.on("close", (code, signal) => finish("failed", `Codex exited before terminal completion (code ${code}, signal ${signal ?? "none"})`));
        abortListener = () => block(cancelled(context.signal));
        context.signal.addEventListener("abort", abortListener, { once: true });
        try {
          if (child.pid) context.onSpawn?.(child.pid);
          if (context.signal.aborted) abortListener();
          else send({ id: 1, method: "initialize", params: {
            clientInfo: { name: "collidr_runner", title: "Collidr Runner", version: "0.1.0" }, capabilities: null,
          } });
        } catch (error) { fail(error); }
      });
    } catch (error) {
      result = { status: "failed", output: "", reason: message(error) };
    } finally {
      if (abortListener) context.signal.removeEventListener("abort", abortListener);
      clearTimeout(interruptTimer);
      try {
        await terminateChild(child);
      } catch (error) {
        result = { ...result, status: result.status === "blocked" ? "blocked" : "failed",
          reason: `${result.reason ? `${result.reason}; ` : ""}Codex child cleanup failed: ${message(error)}` };
      }
      if (stderr.trim()) {
        try { context.log?.(`Codex stderr: ${stderr.trim()}`); } catch { /* A logging failure must not hide the provider outcome. */ }
      }
    }
    return result;
  }
}
