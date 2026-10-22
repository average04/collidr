import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [scenario, capture, ...args] = process.argv.slice(2);
writeFileSync(capture, JSON.stringify({ args, cwd: process.cwd() }) + "\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const turn = (status = "completed", id = "turn-1") => ({
  id, rootTurnId: id, items: [], itemsView: "full", status,
  error: status === "failed" ? { message: "Provider rejected the turn" } : null,
  startedAt: 1, completedAt: 2, durationMs: 1000,
});
let threadId = "managed-thread";
let initialized = false;
let hello = false;
const complete = (status = "completed", id = "turn-1") => send({
  method: "turn/completed", params: { threadId, turn: turn(status, id) },
});
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync(capture, JSON.stringify(message) + "\n");
  if (message.method === "initialize") {
    hello = true;
    if (scenario === "rpc-error") {
      send({ id: message.id, error: { code: -1, message: "Not authenticated" } });
    } else if (scenario === "malformed") {
      process.stdout.write("this is not JSON\n");
    } else if (scenario === "oversize") {
      process.stdout.write("x".repeat(2 * 1024 * 1024));
    } else {
      // Split a JSON frame across writes to exercise the actual stream parser.
      const frame = JSON.stringify({ id: message.id, result: { userAgent: "fixture", platformFamily: "windows", platformOs: "windows" } }) + "\n";
      process.stdout.write(frame.slice(0, 12));
      setTimeout(() => process.stdout.write(frame.slice(12)), 5);
    }
  } else if (message.method === "initialized") {
    initialized = hello;
  } else if (message.method === "config/read") {
    if (!initialized) throw new Error("Handshake was not completed");
    let config = { sandbox_mode: "workspace-write", approval_policy: "on-request" };
    if (scenario === "readonly-config") config = { sandbox_mode: "read-only", approval_policy: "untrusted" };
    if (scenario === "fullaccess-config") config = { sandbox_mode: "danger-full-access", approval_policy: "never" };
    if (scenario === "unset-config") config = {};
    if (scenario === "null-config") config = { sandbox_mode: null, approval_policy: null };
    if (scenario === "granular-config") config = { sandbox_mode: "workspace-write", approval_policy: { granular: {
      sandbox_approval: false, rules: true, skill_approval: false, request_permissions: true, mcp_elicitations: false,
    } } };
    if (scenario === "unknown-sandbox") config.sandbox_mode = "future-mode";
    if (scenario === "unknown-policy") config.approval_policy = "future-policy";
    if (scenario === "invalid-granular") config.approval_policy = { granular: { sandbox_approval: "yes" } };
    if (scenario === "missing-config") config = undefined;
    if (scenario === "config-error") send({ id: message.id, error: { code: -1, message: "Cannot read effective config" } });
    else send({ id: message.id, result: { config, origins: {}, layers: null } });
  } else if (["thread/start", "thread/resume"].includes(message.method)) {
    if (!initialized) throw new Error("Handshake was not completed");
    threadId = message.params.threadId ?? "managed-thread";
    send({ id: message.id, result: { thread: { id: threadId, turns: [] } } });
  } else if (message.method === "turn/start") {
    if (!existsSync(capture + ".session")) throw new Error("Session was not persisted before starting a turn");
    if (scenario === "eof") {
      process.stderr.write("The provider exited before completion\n");
      process.exit(0);
    }
    if (scenario === "elicitation-diagnostics") {
      send({ id: message.id, method: "mcpServer/elicitation/request", params: {
        threadId, turnId: "turn-1", serverName: "collidr", mode: "form",
        message: "Approve the Collidr review lookup. See https://example.test/approve?token=url-secret Authorization: Bearer bearer-secret api_key=key-secret " + "x".repeat(4000),
        url: "https://example.test/hidden-url-secret", requestedSchema: { description: "hidden-schema-secret" },
        token: "hidden-token-secret",
      } });
      return;
    }
    if (scenario.startsWith("approval:")) {
      // Deliberately collide with the client's outstanding request ID.
      send({ id: message.id, method: scenario.slice("approval:".length), params: {
        threadId, turnId: "turn-1", itemId: "item-approval", reason: "Needs a human decision", questions: [],
      } });
      return;
    }
    if (scenario === "early-completion") {
      send({ method: "item/agentMessage/delta", params: {
        threadId, turnId: "unrelated-turn", itemId: "foreign-item", delta: "Stale answer from another turn",
      } });
      send({ method: "item/completed", params: { threadId, turnId: "unrelated-turn", completedAtMs: 2000,
        item: { type: "agentMessage", id: "foreign-item", text: "Stale answer from another turn", phase: "final_answer", memoryCitation: null, delivery: null, questions: null },
      } });
      send({ method: "item/agentMessage/delta", params: {
        threadId, turnId: "turn-1", itemId: "current-item", delta: "Current answer",
      } });
      complete("completed", "unrelated-turn");
      complete();
    }
    send({ id: message.id, result: { turn: turn("inProgress") } });
    send({ method: "turn/started", params: { threadId, turn: turn("inProgress") } });
    if (scenario === "hang") {
      writeFileSync(capture + ".ready", "ready");
      return;
    }
    if (scenario === "output-limit") {
      for (let i = 0; i < 1500; i++) send({ method: "item/agentMessage/delta", params: {
        threadId, turnId: "turn-1", itemId: "message-1", delta: "x".repeat(1024),
      } });
      return;
    }
    if (scenario === "early-completion") return;
    send({ method: "item/agentMessage/delta", params: {
      threadId, turnId: "turn-1", itemId: "message-1", delta: "Review ",
    } });
    send({ method: "item/completed", params: { threadId, turnId: "turn-1", completedAtMs: 2000,
      item: { type: "agentMessage", id: "message-1", text: "Review posted.", phase: "final_answer", memoryCitation: null, delivery: null, questions: null },
    } });
    complete(scenario === "failed" ? "failed" : scenario === "invalid-status" ? "unknown" : "completed");
  } else if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    complete("interrupted");
  }
});
