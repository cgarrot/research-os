// tasks.ts — task specs, lifecycle, leases, result envelopes (spec §9).

export type TaskStatus =
  | "queued"
  | "leased"
  | "running"
  | "submitted"
  | "auditing"
  | "accepted"
  | "rejected"
  | "failed"
  | "expired";

export interface OutputContract {
  description: string;
  /** Object types the accepted result must contain, e.g. ["hypothesis"] or ["claim","evidence"]. */
  requiredObjectTypes?: string[];
  /** Required relations between created objects, checked softly in v0.1 audit. */
  requiresSummary?: boolean;
}

export interface TaskBudget {
  maxMinutes: number;
  maxToolCallsHint?: number;
}

export interface TaskSpec {
  id: string;
  campaignId: string;
  branchId?: string;
  round: number;
  phase: string; // ground | generate | critique | test | consolidate | manage
  type: string; // e.g. "explore", "critique", "formalize", "synthesize"
  role: string; // explorer | adversary | experimentalist | synthesizer | ...
  goal: string;
  inputs: string[]; // research object refs
  expectedOutputs: OutputContract;
  allowedTools: string[]; // research_* tools allowed (advisory in v0.1)
  budget: TaskBudget;
  priority: number;
  leaseSeconds: number;
  /** diversity seed so blind workers diverge (spec §44.1). */
  seed?: string;
  createdAt: string;
  status: TaskStatus;
  attempts: number;
  lease?: { holder: string; expiresAt: string; agentRunId?: string };
  resultRef?: string; // result envelope id
}

export interface ResultEnvelope {
  id: string; // "decision:d_<n>"-like addressable record; stored as object type "decision"
  taskId: string;
  agentRunId: string;
  workerAlias: string;
  status: "success" | "partial" | "failure";
  createdObjects: string[];
  createdArtifacts: string[];
  evidence: string[];
  openQuestions: string[];
  blockers: string[];
  skillsUsed?: string[];
  resourceUsage: { minutesUsed?: number; tokensEstimate?: number };
  summary: string;
  submittedAt: string;
  idempotencyKey?: string;
}

export interface LeaseInfo {
  taskId: string;
  holder: string;
  agentRunId?: string;
  expiresAt: string;
}
