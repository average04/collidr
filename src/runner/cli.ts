import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { openDatabase } from "../db.js";
import { Store } from "../store.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { createConfig, loadConfig, runnerLogPath, writeConfig } from "./config.js";
import { terminateChild } from "./process.js";
import { RunnerScheduler } from "./scheduler.js";
import { processAlive, RunnerState } from "./state.js";
import type { RunnerConfig } from "./types.js";

const HELP = `collidr runner — automatic handoffs using dedicated background sessions

  runner init --workspace PATH --config FILE [--database FILE]
  runner start --config FILE [--background]
  runner task --config FILE --agent ID --prompt TEXT
  runner task --config FILE --agent ID --prompt-file FILE
  runner status --config FILE
  runner retry --config FILE --agent ID
  runner stop --config FILE

Start once, then submit a task to claude-managed. Reviews go to codex-managed.
The runner pauses on permissions, failures, or lack of Collidr progress.
Status includes the reason; retry explicitly resumes the pending delivery.
Your interactive Claude and Codex chats remain separate.
`;

const executableCli = () => fileURLToPath(new URL("../cli.js", import.meta.url));
const log = (message: string) => process.stdout.write(`${new Date().toISOString()} ${message}\n`);

async function foreground(config: RunnerConfig): Promise<void> {
  const state = new RunnerState(config.database);
  const owner = randomUUID();
  let store: Store | undefined;
  let acquired = false;
  let heartbeat: NodeJS.Timeout | undefined;
  let loopError: Error | undefined;
  const abort = new AbortController();
  const stop = () => abort.abort(new Error("Runner stopped"));
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    acquired = state.acquire(config.workspace, owner, process.pid);
    if (!acquired) throw new Error("A runner or an unfinished child still owns this workspace. Use runner status / stop.");
    store = new Store(openDatabase(config.database));
    const scheduler = new RunnerScheduler(config, store, state, { claude: new ClaudeAdapter(), codex: new CodexAdapter() }, { log });
    heartbeat = setInterval(() => {
      try {
        if (state.shouldStop(config.workspace, owner)) stop();
        else state.heartbeat(config.workspace, owner);
      } catch (error) {
        loopError = error instanceof Error ? error : new Error(String(error)); stop();
      }
    }, Math.min(1000, config.pollIntervalMs));
    log(`Runner ready for ${config.workspace}; agents: ${config.agents.map(a => a.id).join(", ")}`);
    process.send?.({ type: "runner-ready", pid: process.pid });
    while (!abort.signal.aborted) {
      await scheduler.tick(abort.signal);
      if (!abort.signal.aborted) await sleep(config.pollIntervalMs, undefined, { signal: abort.signal }).catch(error => {
        if (!abort.signal.aborted) throw error;
      });
    }
    if (loopError) throw loopError;
  } finally {
    clearInterval(heartbeat);
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    if (acquired) state.release(config.workspace, owner);
    store?.db.close(); state.close();
  }
}

async function background(configFile: string, config: RunnerConfig): Promise<void> {
  // IPC confirms the child has acquired its lease and initialized, not just spawned.
  const logFile = runnerLogPath(config);
  const fd = openSync(logFile, "a", 0o600);
  const child = spawn(process.execPath, [executableCli(), "runner", "start", "--config", resolve(configFile)], {
    cwd: config.workspace, windowsHide: true, shell: false, detached: true, stdio: ["ignore", fd, fd, "ipc"],
  });
  closeSync(fd);
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolveReady, reject) => {
      child.on("message", message => {
        if (message && typeof message === "object" && "type" in message && message.type === "runner-ready") resolveReady();
      });
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`Runner exited before startup (code ${code}); see ${logFile}`)));
      timer = setTimeout(() => reject(new Error(`Runner startup timed out; see ${logFile}`)), 10000);
    });
    if (child.connected) child.disconnect();
    child.unref();
    process.stdout.write(`Runner started (PID ${child.pid}). Log: ${logFile}\n`);
  } catch (error) {
    await terminateChild(child);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function runnerMain(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (!command || ["help", "--help", "-h"].includes(command)) { process.stdout.write(HELP); return 0; }
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    config: { type: "string" }, workspace: { type: "string" }, database: { type: "string" },
    agent: { type: "string" }, prompt: { type: "string" }, "prompt-file": { type: "string" },
    background: { type: "boolean" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) { process.stdout.write(HELP); return 0; }
  if (positionals.length) throw new Error(`Unexpected arguments: ${positionals.join(" ")}`);
  if (!values.config) throw new Error("--config FILE is required");
  const file = resolve(values.config);
  if (command === "init") {
    const config = createConfig(resolve(values.workspace ?? process.cwd()), executableCli(), values.database);
    writeConfig(file, config);
    process.stdout.write(`Created ${file}\nDedicated agents: ${config.agents.map(a => a.id).join(", ")}\n`);
    return 0;
  }
  const config = loadConfig(file, { launch: !["stop", "status", "retry"].includes(command) });
  // Creates the sidecar directory as well, before a background log is opened.
  const state = new RunnerState(config.database);
  try {
    switch (command) {
      case "start":
        state.close();
        if (values.background) await background(file, config); else await foreground(config);
        return 0;
      case "status":
        process.stdout.write(JSON.stringify(state.status(config.workspace), null, 2) + "\n");
        return 0;
      case "task": {
        const agent = config.agents.find(a => a.id === values.agent);
        if (!agent) throw new Error(`--agent must name one of: ${config.agents.map(a => a.id).join(", ")}`);
        if (Boolean(values.prompt) === Boolean(values["prompt-file"])) throw new Error("Supply exactly one of --prompt TEXT or --prompt-file FILE");
        const prompt = values.prompt ?? readFileSync(resolve(values["prompt-file"]!), "utf8");
        if (!prompt.trim() || Buffer.byteLength(prompt, "utf8") > 65536) throw new Error("Task prompt must contain 1–65536 bytes");
        const id = state.enqueue(config.workspace, agent.id, prompt);
        process.stdout.write(`Queued task ${id} for ${agent.id}\n`);
        return 0;
      }
      case "retry":
        if (!config.agents.some(a => a.id === values.agent)) throw new Error("--agent must name a configured participant");
        state.retry(config.workspace, values.agent!);
        process.stdout.write(`Retry enabled for ${values.agent}\n`);
        return 0;
      case "stop": {
        state.requestStop(config.workspace);
        const deadline = Date.now() + 30000;
        while (state.status(config.workspace).lease && Date.now() < deadline) await sleep(100);
        if (state.status(config.workspace).lease) throw new Error("Stop requested, but the runner has not released its lease. Inspect status and log before restarting.");
        if (state.status(config.workspace).agents.some(agent => agent.active?.childPid && processAlive(agent.active.childPid))) {
          throw new Error("Supervisor stopped, but an owned child is still exiting. Inspect status before restarting.");
        }
        process.stdout.write("Runner stopped.\n");
        return 0;
      }
      default: throw new Error(`Unknown runner command: ${command}\n${HELP}`);
    }
  } finally { if (command !== "start") state.close(); }
}
