// verification.ts — evidence objects, verifications, verifier definitions, hierarchy (spec §18).

export interface EvidenceSpec {
  claimId?: string;
  type: string; // "executable" | "source" | "logical" | "observation" | ...
  sourceRefs: string[];
  artifactRefs: string[];
  result: "supports" | "contradicts" | "neutral";
  strength: number; // 0..1
  reproducible: boolean | null;
  metadata: Record<string, unknown>;
}

export type VerificationStatus = "passed" | "failed" | "error";

export interface VerificationRecord {
  id: string;
  campaignId: string;
  targetId: string; // usually a claim id
  verifierId: string; // e.g. "mathematics-lite:python-exact-assert"
  requestedBy: string;
  requestedAt: string;
  status: VerificationStatus | "pending";
  output?: string;
  exitCode?: number;
  artifactRef?: string;
  completedAt?: string;
  /** claim status transitions applied by this verification (core-only). */
  appliedTransitions?: { from: string; to: string }[];
  /** Real domain covered by the verifier (parsed from the script verdict) — V0.2. */
  verifiedDomain?: VerifiedDomainLite;
}

/** Lightweight domain shape stored on verification records and claims. */
export interface VerifiedDomainLite {
  mode: "point" | "exhaustive" | "witness" | "symbolic";
  expression: string;
  variables: { name: string; min: number; max: number }[];
  testedCases: number;
  realCoverage?: { variable: string; min: number; max: number; note?: string }[];
}

export interface ExecVerifierDefinition {
  /** "<moduleId>:<name>" — assigned by the module loader. */
  id: string;
  moduleId: string;
  /** Resolved module dir — set by the loader (not part of module JSON). */
  moduleDir?: string;
  /** Optional short name; defaults to the json file basename. */
  name?: string;
  kind: "exec";
  label: string;
  description: string;
  /** Command template. Placeholders: {script} {input_file} {workspace} {campaign_dir}. */
  command: string[];
  /** Optional script path relative to the module dir, substituted as {script}. */
  script?: string;
  timeoutSeconds: number;
  /** Exit codes treated as pass (default [0]). Non-zero = failed, 124 = timeout error. */
  passExitCodes?: number[];
  /** Claim status applied to the target when passed / failed. */
  onPass: string; // epistemic status e.g. "verified"
  onFail: string; // e.g. "falsified" or "inconclusive"
  inputs: { name: string; description: string; required: boolean }[];
}

export type VerifierDefinition = ExecVerifierDefinition;

/** Generic default ordering (spec §18.2) — informational for retrieval ranking. */
export const VERIFICATION_HIERARCHY = [
  "formal_deterministic_verifier",
  "exact_executable_counterexample",
  "reproduced_executable_experiment",
  "single_executable_experiment",
  "trusted_source_evidence",
  "independent_human_review",
  "independent_llm_judge",
  "multi_agent_consensus",
  "single_agent_judgment",
  "self_confidence",
] as const;
