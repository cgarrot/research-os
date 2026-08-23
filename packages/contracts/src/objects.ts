// objects.ts — research objects, epistemic statuses and graph edges (spec §3.4, §3.5, §16).

export const CORE_OBJECT_TYPES = [
  "objective",
  "question",
  "branch",
  "hypothesis",
  "claim",
  "evidence",
  "observation",
  "anomaly",
  "experiment",
  "experiment_result",
  "artifact_ref",
  "source",
  "method",
  "skill_object",
  "failure",
  "decision",
  "note",
  "memory",
] as const;

export const EPISTEMIC_STATUSES = [
  "speculative",
  "unverified",
  "empirically_supported",
  "source_supported",
  "reproduced",
  "verified",
  "falsified",
  "contradicted",
  "inconclusive",
  "superseded",
] as const;

export type EpistemicStatus = (typeof EPISTEMIC_STATUSES)[number];

/** Statuses only the verification path may assign (spec invariant C). */
export const VERIFIER_ONLY_STATUSES: EpistemicStatus[] = ["verified", "falsified", "reproduced"];

export interface ResearchObject {
  id: string;
  campaignId: string;
  type: string; // core type or namespaced module type e.g. "math.counterexample"
  title: string;
  content: Record<string, unknown>;
  epistemicStatus?: EpistemicStatus;
  verificationGrade?: string; // e.g. "deterministic-exec", "source-backed"
  tags: string[];
  branchId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchBranch {
  id: string;
  campaignId: string;
  parentBranchIds: string[];
  thesis: string;
  methodTags: string[];
  status: "seeded" | "active" | "stalled" | "parked" | "closed";
  taskCount: number;
  acceptedCount: number;
  blockers: string[];
  createdAt: string;
  updatedAt: string;
}

export const CORE_EDGE_TYPES = [
  "supports",
  "contradicts",
  "depends_on",
  "derived_from",
  "tests",
  "verified_by",
  "falsified_by",
  "uses_method",
  "uses_tool",
  "produces",
  "consumes",
  "cites",
  "reproduces",
  "generalizes",
  "specializes",
  "analogous_to",
  "inspired_by",
  "failed_because",
  "blocks",
  "resolves",
  "part_of",
  "forked_from",
] as const;

export interface ResearchEdge {
  id: string;
  campaignId: string;
  sourceId: string;
  targetId: string;
  relation: string; // core or namespaced
  properties: Record<string, unknown>;
  evidenceRef?: string;
  createdBy: string;
  createdAt: string;
}
