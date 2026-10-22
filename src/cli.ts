#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { accessSync, constants, existsSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { compareVersions, defaultDatabasePath, MIN_SQLITE_VERSION, openDatabase, sqliteVersion } from "./db.js";
import { isCollidrError } from "./errors.js";
import { describeEvent, describeThread } from "./format.js";
import { LATEST_SCHEMA_VERSION } from "./schema.js";
import { createServer } from "./server.js";
import { Store } from "./store.js";
import { VERSION } from "./version.js";
import { resolveWorkspace } from "./workspace.js";

const HELP = `collidr ${VERSION} — local MCP coordination hub for AI agents

Usage:
  collidr serve                     Run the stdio MCP server (what MCP clients spawn)
  collidr watch [--thread <id>] [--workspace <path>] [--from <seq>]
                                    Live tail of events
  collidr threads [--workspace <path>] [--status open|resolved|unresolved]
  collidr show <thread_id>          Thread state, revisions, requests and history
  collidr doctor                    Check Node, SQLite, database and configuration
  collidr runner --help             Manage automatic Claude/Codex handoffs

Environment:
  COLLIDR_PARTICIPANT   Stable participant ID for this MCP server (e.g. codex-reviewer)
  COLLIDR_MODEL, COLLIDR_CLIENT, COLLIDR_ROLE, COLLIDR_DISPLAY_NAME
  COLLIDR_CAPABILITIES  Comma-separated, e.g. read_patch,inspect_repo,run_tests
  COLLIDR_WORKSPACE     Repository path to use when the server's cwd isn't one
  COLLIDR_DB            Database file (default ~/.collidr/hub.db)
  COLLIDR_MAX_WAIT_S    Upper bound for wait_for_messages (default 50)
`;

const env = (name: string) => {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
};

function openStore(): Store {
  return new Store(openDatabase(defaultDatabasePath()));
}

async function serve(): Promise<void> {
  const store = openStore();
  const { server } = createServer(store, {
    participantId: env("COLLIDR_PARTICIPANT"),
    displayName: env("COLLIDR_DISPLAY_NAME"),
    client: env("COLLIDR_CLIENT"),
    model: env("COLLIDR_MODEL"),
    role: env("COLLIDR_ROLE"),
    capabilities: env("COLLIDR_CAPABILITIES")?.split(",").map((s) => s.trim()).filter(Boolean),
    maxWaitS: env("COLLIDR_MAX_WAIT_S") ? Number(env("COLLIDR_MAX_WAIT_S")) : undefined,
  });
  const transport = new StdioServerTransport();
  const shutdown = () => {
    try {
      store.db.close();
    } finally {
      process.exit(0);
    }
  };
  transport.onclose = shutdown;
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(transport);
}

async function watch(flags: { thread?: string; workspace?: string; from?: string }): Promise<void> {
  const store = openStore();
  const workspaceId = flags.workspace ? resolveWorkspace(store, flags.workspace).id : undefined;
  let cursor = flags.from !== undefined ? Number(flags.from) : Math.max(0, store.maxSeq() - 20);
  process.stdout.write(`watching ${flags.thread ? `thread ${flags.thread}` : workspaceId ? `workspace ${workspaceId}` : "all threads"} (Ctrl+C to stop)\n`);
  for (;;) {
    const page = store.listAllEvents({ afterSeq: cursor, threadId: flags.thread, workspaceId, limit: 200 });
    for (const ev of page.events) process.stdout.write(describeEvent(ev) + "\n");
    cursor = page.event_cursor;
    if (!page.has_more) await new Promise((r) => setTimeout(r, 500));
  }
}

function threads(flags: { workspace?: string; status?: string }): void {
  const store = openStore();
  const ws = resolveWorkspace(store, flags.workspace);
  const status = flags.status as "open" | "resolved" | "unresolved" | undefined;
  let after: string | undefined;
  process.stdout.write(`workspace ${ws.repo_root}\n`);
  let count = 0;
  do {
    const page = store.listThreads(ws.id, { status, afterId: after, limit: 200 });
    for (const t of page.threads) process.stdout.write(describeThread(t) + "\n");
    count += page.threads.length;
    after = page.next_after_id ?? undefined;
  } while (after);
  if (count === 0) process.stdout.write("(no threads)\n");
}

function show(threadId: string): void {
  const store = openStore();
  const s = store.threadSummary(threadId);
  const out: string[] = [describeThread(s.thread), ""];
  out.push(`participants: ${s.participants.map((p) => `${p.participant_id} (${p.role})`).join(", ")}`);
  out.push(
    `latest: r${s.latest_revision.number} ${s.latest_revision.content_type} sha256:${s.latest_revision.content_hash.slice(0, 12)}` +
      (s.latest_revision.head_commit ? ` head ${s.latest_revision.head_commit}` : ""),
  );
  out.push(
    `round ${s.thread.current_round} requests: ` +
      (s.current_round_requests.map((r) => `${r.assignee_id}=${r.status}`).join(", ") || "none"),
  );
  if (s.awaiting.length) out.push(`waiting on: ${s.awaiting.join(", ")}`);
  if (s.resolution) {
    out.push(`resolution: ${s.resolution.outcome} — ${s.resolution.summary}`);
    for (const o of s.resolution.outstanding_objections) out.push(`  objection from ${o.reviewer_id}: ${o.body}`);
  }
  out.push("", "history:");
  let after = 0;
  for (;;) {
    const page = store.listAllEvents({ afterSeq: after, threadId, limit: 200 });
    for (const ev of page.events) out.push(describeEvent(ev));
    after = page.event_cursor;
    if (!page.has_more) break;
  }
  process.stdout.write(out.join("\n") + "\n");
}

function doctor(): number {
  let problems = 0;
  const line = (okay: boolean, label: string, detail: string) => {
    if (!okay) problems++;
    process.stdout.write(`${okay ? "ok  " : "FAIL"} ${label}: ${detail}\n`);
  };
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  line(nodeMajor >= 22, "node", process.versions.node);

  const file = defaultDatabasePath();
  try {
    const store = openStore();
    const v = sqliteVersion(store.db);
    line(compareVersions(v.split(".").map(Number), MIN_SQLITE_VERSION) >= 0, "sqlite", `${v} (need >= ${MIN_SQLITE_VERSION.join(".")})`);
    const mode = store.db.pragma("journal_mode", { simple: true });
    line(mode === "wal", "journal mode", String(mode));
    const schema = store.db.pragma("user_version", { simple: true });
    line(schema === LATEST_SCHEMA_VERSION, "schema", `v${schema}`);
    line(true, "database", file);
    accessSync(dirname(file), constants.W_OK);
    store.db.close();
  } catch (err) {
    line(false, "database", `${file}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const pid = env("COLLIDR_PARTICIPANT");
  line(true, "COLLIDR_PARTICIPANT", pid ?? "(not set here; set it per client in each MCP config)");
  try {
    const store = openStore();
    const ws = resolveWorkspace(store);
    line(true, "workspace (cwd)", `${ws.repo_root}${ws.repo_remote ? ` (${ws.repo_remote})` : ""}`);
    store.db.close();
  } catch {
    line(true, "workspace (cwd)", "not inside a git repository (agents can pass `workspace` explicitly)");
  }
  if (!existsSync(file)) line(false, "database file", "missing");
  process.stdout.write(problems === 0 ? "\nAll checks passed.\n" : `\n${problems} problem(s) found.\n`);
  return problems === 0 ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "runner") return (await import("./runner/cli.js")).runnerMain(rest);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      thread: { type: "string" },
      workspace: { type: "string" },
      status: { type: "string" },
      from: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  switch (command) {
    case "serve":
      await serve();
      return -1; // keep running
    case "watch":
      await watch(values);
      return 0;
    case "threads":
      threads(values);
      return 0;
    case "show":
      if (!positionals[0]) throw new Error("usage: collidr show <thread_id>");
      show(positionals[0]);
      return 0;
    case "doctor":
      return doctor();
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err: unknown) => {
    const msg = isCollidrError(err) ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
    process.stderr.write(`collidr: ${msg}\n`);
    process.exitCode = 1;
  },
);
