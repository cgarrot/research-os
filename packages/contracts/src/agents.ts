// agents.ts — actor runs, model profiles, runtime & transport adapter interfaces (spec §6, §7).
// The core depends on these INTERFACES only — never on Pi or pi-mesh types (invariant G).

export type AgentRunStatus = "running" | "completed" | "failed" | "killed";

export interface AgentRun {
  id: string;
  campaignId: string;
  taskId?: string;
  workerAlias: string;
  mode: "headless" | "interactive";
  provider: string;
  model: string;
  pid?: number;
  startedAt: string;
  endedAt?: string;
  status: AgentRunStatus;
  summary?: string;
  tokensEstimate?: number;
  tokensEstimated?: boolean;
}

export interface AgentRuntimeCapabilities {
  id: string;
  modes: string[];
  tools: string[];
}

export interface AgentSpawnSpec {
  campaignId: string;
  workspaceDir: string;
  alias: string;
  role: string;
  model: { provider: string; model: string; thinkingLevel?: string };
  taskPrompt: string;
  mode: "headless" | "interactive";
  /** hard wall-clock kill for headless runs (minutes) */
  maxRunMinutes?: number;
  env?: Record<string, string>;
}

export interface AgentHandle {
  runId: string;
  alias: string;
  pid?: number;
}

export interface AgentRuntimeState {
  runId: string;
  status: AgentRunStatus;
  exitCode?: number;
  stdout?: string;
  tokensEstimate?: number;
  tokensEstimated?: boolean;
}

export interface AgentRuntimeAdapter {
  id: string;
  capabilities(): Promise<AgentRuntimeCapabilities>;
  spawn(spec: AgentSpawnSpec): Promise<AgentHandle>;
  inspect(handle: AgentHandle): Promise<AgentRuntimeState>;
  terminate(handle: AgentHandle): Promise<void>;
}

export interface TransportIdentity {
  alias: string;
  rooms: string[];
}

export interface TransportReceipt {
  ok: boolean;
  status: string; // delivered | queued_offline | expired | error
  msgId?: string;
  detail?: string;
}

export interface AgentTransportAdapter {
  id: string;
  connect(identity: TransportIdentity): Promise<void>;
  send(to: string, message: string, opts?: { room?: string; refs?: string[] }): Promise<TransportReceipt>;
  broadcast(room: string, message: string, refs?: string[]): Promise<TransportReceipt>;
  status(): Promise<unknown>;
  close(): Promise<void>;
}
