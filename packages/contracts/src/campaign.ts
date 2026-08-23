// campaign.ts — campaign spec, objective contract, budgets, stop conditions (spec §3.1, §3.2, §30).

export type CampaignStatus = "created" | "running" | "paused" | "completed" | "stopped";

export interface SuccessCriterion {
  type: "claim_status" | "verified_object" | "falsified_object" | "artifact" | "custom";
  /** e.g. for claim_status: "verified" | "falsified"; for verified_object: object type */
  value: string;
  description?: string;
}

export interface DeliverableSpec {
  kind: "report" | "artifact" | "verified_claim";
  description: string;
}

export interface ObjectiveSpec {
  id: string;
  statement: string;
  questions: string[];
  deliverables: DeliverableSpec[];
  successCriteria: SuccessCriterion[];
  constraints: string[];
  exclusions: string[];
  assumptions: string[];
  riskClass: string;
  version: number;
  /** sha256 of the canonical JSON — injected into every ContextPack (anti instruction-drift, §51.5). */
  contentHash?: string;
}

export interface BudgetLimits {
  maxAgentRuns: number;
  maxTasks: number;
  maxRounds: number;
  maxExperiments: number;
  wallClockMinutes: number;
  /** Rough token ceiling; enforced best-effort from reported usage (v0.1 estimate). */
  maxTokensEstimate: number;
}

export interface BudgetConsumed {
  agentRuns: number;
  tasksCreated: number;
  experiments: number;
  tokensEstimate: number;
  startedAt?: string;
}

export interface ModelProfileRef {
  id: string; // e.g. "zai-glm-5.3"
  provider: string; // "zai"
  model: string; // "glm-5.3"
  runtime: string; // "pi"
  thinkingLevel?: string; // "max"
  tags: string[];
}

export interface SearchPolicy {
  policy: "round-robin" | "quality_diversity";
  /** Blind generators per generation round (spec §7.6 round A). */
  blindGenerators: number;
  maxBranches: number;
}

export interface CampaignSpec {
  id?: string; // assigned at creation: "campaign:c_<n>"
  title: string;
  modules: string[];
  objective: {
    statement: string;
    questions: string[];
    deliverables: DeliverableSpec[];
    successCriteria: SuccessCriterion[];
    constraints: string[];
    exclusions: string[];
    assumptions: string[];
    riskClass: string;
  };
  models: {
    defaultPool: ModelProfileRef[];
  };
  search: SearchPolicy;
  budgets: BudgetLimits;
  autonomy: {
    level: string; // L0..L5 label (spec §32)
    humanApprovalRequiredFor: string[];
  };
  workers: {
    /** headless workers researchd spawns itself */
    autoSpawn: number;
    leaseSeconds: number;
    /** hard ceiling for ONE headless worker run (minutes). Long-run campaigns set this high; default derives from wall-clock budget. */
    maxRunMinutes?: number;
    /** how pi binary is invoked (adapter concern; core just stores it) */
    runtime?: string;
  };
  stop: {
    onSuccess: boolean;
    onBudgetExhausted: boolean;
    noProgressRounds: number;
    /** ALL criteria must be met to complete (default "any" = first met completes). */
    successSemantics?: "any" | "all";
    /** success criteria are only evaluated from this round on (anti round-1 scout completion). */
    minRounds?: number;
    /** require at least one accepted critique AND one accepted test task before success can complete. */
    requireCycle?: boolean;
  };
  verification: {
    requireIndependentAudit: boolean;
  };
  /** Domain-module phase guidance (injected into task goals + ContextPack). Set by the core at creation; replay-safe (lives in the campaign.created event). */
  modulePrompts?: Record<string, string>;
}

export interface CampaignState {
  id: string;
  title: string;
  status: CampaignStatus;
  objective: ObjectiveSpec;
  modules: string[];
  modelPools: { defaultPool: ModelProfileRef[] };
  search: SearchPolicy;
  budgets: { limits: BudgetLimits; consumed: BudgetConsumed };
  autonomy: CampaignSpec["autonomy"];
  workers: CampaignSpec["workers"];
  stop: CampaignSpec["stop"];
  verification: CampaignSpec["verification"];
  currentRound: number;
  noProgressRounds: number;
  modulePrompts?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  workspaceDir?: string;
}
