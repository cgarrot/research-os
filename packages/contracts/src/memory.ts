// memory.ts — memory kinds, skills (spec §12, §13).

export type MemoryKind =
  | "semantic"
  | "episodic"
  | "procedural"
  | "negative"
  | "inspiration";

export type MemoryScope = "run-local" | "branch-local" | "campaign-local" | "workspace-global";

export interface MemoryItem {
  id: string; // a memory: object id
  kind: MemoryKind;
  scope: MemoryScope;
  campaignId: string;
  branchId?: string;
  title: string;
  content: Record<string, unknown>;
  /** refs to evidence / episodes backing this memory — trust comes from these, not self-judgment (§14.3). */
  evidenceRefs: string[];
  verificationGrade?: string;
  activation: number; // 0..1, decays; boosted by successful reuse
  createdBy: string;
  createdAt: string;
}

export interface ResearchSkill {
  id: string;
  name: string;
  scope: MemoryScope;
  activation: string[];
  procedure: string[];
  termination: string[];
  warnings: string[];
  antiPatterns: string[];
  evidenceRefs: string[];
  compatibleDomains: string[];
  compatibleRoles: string[];
  verificationState: "candidate" | "validated" | "active" | "deprecated";
  citations?: number;
  version: number;
  createdBy: string;
  createdAt: string;
}

export type RetrievalIntent =
  | "retrieve_evidence"
  | "retrieve_known_methods"
  | "retrieve_similar_problems"
  | "retrieve_failures"
  | "retrieve_skills"
  | "retrieve_analogies"
  | "retrieve_sources"
  | "retrieve_all";
