export type Provider = "claude" | "codex";

export interface RunnerAgent {
  id: string;
  provider: Provider;
  command: string;
  args: string[];
  model?: string;
  instructions: string;
  allowedTools: string[];
  maxTurns: number;
}

export interface RunnerConfig {
  version: 1;
  workspace: string;
  database: string;
  cliPath: string;
  pollIntervalMs: number;
  turnTimeoutMs: number;
  maxTurnsPerThread: number;
  agents: RunnerAgent[];
}

export interface AgentContext {
  agent: RunnerAgent;
  workspace: string;
  database: string;
  cliPath: string;
  prompt: string;
  sessionId: string | null;
  signal: AbortSignal;
  onSession(id: string): void;
  onSpawn?(pid: number): void;
  log?(message: string): void;
}

export interface AgentResult {
  status: "completed" | "blocked" | "failed";
  sessionId?: string;
  output: string;
  reason?: string;
}

export interface AgentAdapter {
  run(context: AgentContext): Promise<AgentResult>;
}
