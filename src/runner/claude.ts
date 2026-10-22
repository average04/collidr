import { StringDecoder } from "node:string_decoder";
import { spawnAgent, terminateChild } from "./process.js";
import type { AgentAdapter, AgentContext, AgentResult } from "./types.js";

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 64 * 1024;
const MAX_DIAGNOSTIC_CHARS = 16 * 1024;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortedReason(context: AgentContext): string {
  return `Claude run cancelled: ${context.signal.reason === undefined ? "stop requested" : errorText(context.signal.reason)}`;
}

export class ClaudeAdapter implements AgentAdapter {
  async run(context: AgentContext): Promise<AgentResult> {
    if (context.signal.aborted) {
      return { status: "blocked", output: "", sessionId: context.sessionId ?? undefined, reason: abortedReason(context) };
    }

    const env: Record<string, string> = {
      COLLIDR_PARTICIPANT: context.agent.id,
      COLLIDR_CLIENT: "claude",
      COLLIDR_WORKSPACE: context.workspace,
      COLLIDR_DB: context.database,
    };
    if (context.agent.model) env.COLLIDR_MODEL = context.agent.model;
    const mcpConfig = JSON.stringify({ mcpServers: { collidr: {
      type: "stdio", command: process.execPath, args: [context.cliPath, "serve"], env,
    } } });
    const args = [
      ...context.agent.args, "-p", "--output-format", "stream-json", "--verbose",
      "--permission-mode", "manual", "--permission-prompts", "none",
      "--strict-mcp-config", "--mcp-config", mcpConfig,
      "--max-turns", String(context.agent.maxTurns),
    ];
    if (context.agent.allowedTools.length) args.push("--allowedTools", context.agent.allowedTools.join(","));
    if (context.agent.model) args.push("--model", context.agent.model);
    if (context.sessionId) args.push("--resume", context.sessionId);

    let child: ReturnType<typeof spawnAgent>;
    try {
      child = spawnAgent(context.agent.command, args, { cwd: context.workspace, env: {
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1", CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1",
      } });
    } catch (error) {
      return { status: "failed", output: "", sessionId: context.sessionId ?? undefined, reason: `Could not start Claude: ${errorText(error)}` };
    }

    return new Promise<AgentResult>((resolve) => {
      const decoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      let pendingLine = "";
      let streamBytes = 0;
      let stderr = "";
      let output = "";
      let sessionId = context.sessionId ?? undefined;
      let initialized = false;
      let successfulResult = false;
      let outcome: { status: "blocked" | "failed"; reason: string } | undefined;
      let termination: Promise<void> | undefined;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        context.signal.removeEventListener("abort", abort);
        const reason = outcome ? `${outcome.reason.slice(0, MAX_DIAGNOSTIC_CHARS)}${stderr.trim() ? `\nClaude stderr: ${stderr.trim()}` : ""}` : undefined;
        resolve({ status: outcome?.status ?? "completed", sessionId, output, ...(reason ? { reason } : {}) });
      };
      const stop = (status: "blocked" | "failed", reason: string) => {
        if (settled || outcome) return;
        outcome = { status, reason };
        termination = terminateChild(child).catch((error: unknown) => {
          outcome!.reason += `; process cleanup failed: ${errorText(error)}`;
        });
        void termination.then(finish);
      };
      const abort = () => stop("blocked", abortedReason(context));
      const acceptSession = (id: unknown): boolean => {
        if (typeof id !== "string" || !id.trim() || id.length > 256) {
          stop("failed", "Claude returned an invalid session ID");
          return false;
        }
        if (sessionId && sessionId !== id) {
          stop("failed", "Claude returned a different session ID from the managed conversation");
          return false;
        }
        if (!initialized) {
          sessionId = id;
          initialized = true;
          context.onSession(id);
        }
        return !outcome;
      };
      const parseLine = (line: string) => {
        if (outcome || !line.trim()) return;
        if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
          stop("failed", "Claude output line exceeded the size limit");
          return;
        }
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as Record<string, unknown>).type !== "string") {
            stop("failed", "Claude returned an invalid NDJSON event");
            return;
          }
          const event = parsed as Record<string, unknown>;
          if (event.type === "system" && event.subtype === "init") {
            acceptSession(event.session_id);
          } else if (event.type === "system" && event.subtype === "permission_denied") {
            stop("blocked", `Claude needs permission for ${typeof event.tool_name === "string" ? event.tool_name : "a tool"}: ${typeof event.message === "string" ? event.message : "permission denied"}`);
          } else if (event.type === "system" && event.subtype === "session_state_changed" && event.state === "requires_action") {
            stop("blocked", "Claude requires a user response or permission approval");
          } else if (event.type === "result") {
            if (!acceptSession(event.session_id)) return;
            if (typeof event.result === "string") output = event.result.slice(0, MAX_OUTPUT_CHARS);
            if (Array.isArray(event.permission_denials) && event.permission_denials.length) {
              stop("blocked", "Claude reported denied tool permissions");
            } else if (event.subtype !== "success" || event.is_error !== false) {
              const details = Array.isArray(event.errors) ? event.errors.filter((value): value is string => typeof value === "string").join("; ") : output;
              stop("blocked", `Claude result ${String(event.subtype)}: ${details || "provider could not complete the turn"}`);
            } else if (event.deferred_tool_use || event.stop_reason === "tool_deferred" || (typeof event.terminal_reason === "string" && event.terminal_reason !== "completed")) {
              stop("blocked", `Claude stopped before completion: ${String(event.terminal_reason ?? event.stop_reason ?? "deferred tool")}`);
            } else if (typeof event.result !== "string") {
              stop("failed", "Claude success result has no text output");
            } else {
              successfulResult = true;
            }
          }
        } catch (error) {
          stop("failed", `Could not process Claude NDJSON: ${errorText(error)}`);
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        if (outcome || settled) return;
        streamBytes += chunk.length;
        if (streamBytes > MAX_STREAM_BYTES) {
          stop("failed", "Claude output exceeded the stream size limit");
          return;
        }
        pendingLine += decoder.write(chunk);
        let newline: number;
        while (!outcome && (newline = pendingLine.indexOf("\n")) >= 0) {
          const line = pendingLine.slice(0, newline);
          pendingLine = pendingLine.slice(newline + 1);
          parseLine(line);
        }
        if (!outcome && Buffer.byteLength(pendingLine, "utf8") > MAX_LINE_BYTES) stop("failed", "Claude output line exceeded the size limit");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + stderrDecoder.write(chunk)).slice(-MAX_DIAGNOSTIC_CHARS);
      });
      child.once("error", (error) => stop("failed", `Could not start Claude: ${errorText(error)}`));
      child.stdin.on("error", (error) => stop("failed", `Could not send Claude prompt: ${errorText(error)}`));
      child.stdout.on("error", (error) => stop("failed", `Could not read Claude output: ${errorText(error)}`));
      child.stderr.on("error", (error) => stop("failed", `Could not read Claude diagnostics: ${errorText(error)}`));
      child.once("close", (code, signal) => {
        stderr = (stderr + stderrDecoder.end()).slice(-MAX_DIAGNOSTIC_CHARS);
        if (!outcome) {
          pendingLine += decoder.end();
          parseLine(pendingLine);
        }
        if (!outcome && (code !== 0 || signal)) outcome = { status: "failed", reason: `Claude exited with ${signal ? `signal ${signal}` : `code ${code}`}` };
        if (!outcome && !successfulResult) outcome = { status: "failed", reason: "Claude exited without a successful result" };
        if (!termination) {
          termination = terminateChild(child).catch((error: unknown) => {
            outcome = { status: "failed", reason: `${outcome?.reason ? `${outcome.reason}; ` : ""}Claude process cleanup failed: ${errorText(error)}` };
          });
        }
        void termination.then(finish);
      });
      context.signal.addEventListener("abort", abort, { once: true });
      try { if (child.pid) context.onSpawn?.(child.pid); }
      catch (error) { stop("failed", `Could not record Claude child process: ${errorText(error)}`); }
      if (context.signal.aborted) abort();
      else if (!outcome) child.stdin.end(context.prompt, "utf8");
    });
  }
}
