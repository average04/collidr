import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";

const mode = process.argv[2];
const args = process.argv.slice(3);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");
const resumeAt = args.indexOf("--resume");
const sessionId = mode === "wrong-session" ? "unexpected-session" : resumeAt >= 0 ? args[resumeAt + 1] : "fixture-session";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
send({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd(), tools: [], mcp_servers: [{ name: "collidr", status: "connected" }] });

const result = {
  type: "result", subtype: "success", session_id: sessionId, is_error: false,
  num_turns: 2, duration_ms: 10, duration_api_ms: 5, stop_reason: "end_turn",
  total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [],
  result: JSON.stringify({ args, prompt, cwd: process.cwd(), stateEvents: process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS }),
};

switch (mode) {
  case "hang":
  case "wrong-session":
    setInterval(() => {}, 1000);
    break;
  case "denied":
    send({ type: "system", subtype: "permission_denied", session_id: sessionId, tool_name: "Bash", tool_use_id: "tool-1", message: "Approval required" });
    setInterval(() => {}, 1000);
    break;
  case "requires-action":
    send({ type: "system", subtype: "session_state_changed", session_id: sessionId, state: "requires_action" });
    setInterval(() => {}, 1000);
    break;
  case "result-denial":
    send({ ...result, permission_denials: [{ tool_name: "Edit", tool_use_id: "tool-2", tool_input: { file_path: "a.ts" } }] });
    break;
  case "max-turns":
    send({ ...result, subtype: "error_max_turns", is_error: true, result: undefined, errors: ["Reached maximum number of turns"] });
    setInterval(() => {}, 1000);
    break;
  case "error-success":
    send({ ...result, is_error: true, result: "Authentication failed" });
    break;
  case "deferred":
    send({ ...result, terminal_reason: "tool_deferred", stop_reason: "tool_deferred", deferred_tool_use: { id: "tool-3", name: "Edit", input: {} } });
    break;
  case "interrupted":
    send({ ...result, terminal_reason: "aborted_tools" });
    break;
  case "missing-result-text":
    send({ ...result, result: undefined });
    break;
  case "wrong-result-session":
    send({ ...result, session_id: "different-session" });
    break;
  case "nonzero":
    process.stderr.write("provider exited unexpectedly\n");
    send(result);
    process.exitCode = 7;
    break;
  case "eof":
    break;
  case "malformed":
    process.stdout.write("{not json}\n");
    setInterval(() => {}, 1000);
    break;
  case "oversized":
    process.stdout.write("x".repeat(2 * 1024 * 1024));
    setInterval(() => {}, 1000);
    break;
  case "stderr":
    process.stderr.write("x".repeat(100_000) + "diagnostic-tail");
    break;
  case "chunked": {
    send({ type: "future_event", value: true });
    const encoded = Buffer.from(JSON.stringify({ ...result, result: "Complete 🦉" }));
    const split = encoded.indexOf(Buffer.from("🦉")) + 2;
    process.stdout.write(encoded.subarray(0, split));
    await delay(10);
    process.stdout.write(encoded.subarray(split));
    break;
  }
  case "later-error":
    send(result);
    send({ ...result, subtype: "error_during_execution", is_error: true, errors: ["Background task failed"], result: undefined });
    break;
  case "success-descendant": {
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: process.platform === "win32", windowsHide: true });
    descendant.unref();
    send({ ...result, result: String(descendant.pid) });
    break;
  }
  default:
    send(result);
}
