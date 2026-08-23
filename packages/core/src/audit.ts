// audit.ts — rule-based auditor (spec §43, read-only with respect to environment).
// v0.1: deterministic structural audit of result envelopes. LLM audit can be
// layered later, but acceptance stays core-owned.
import type { CampaignProjection } from "./core.js";
import type { ResultEnvelope, TaskSpec } from "@research-os/contracts";
import { VERIFIER_ONLY_STATUSES } from "@research-os/contracts";

export interface AuditResult {
  accepted: boolean;
  verifiedOutputs: string[];
  rejectedOutputs: string[];
  reasons: string[];
  evidenceRefs: string[];
}

export function auditEnvelope(proj: CampaignProjection, task: TaskSpec, env: ResultEnvelope): AuditResult {
  const reasons: string[] = [];
  const verifiedOutputs: string[] = [];
  const rejectedOutputs: string[] = [];

  if (!env.summary || env.summary.trim().length < 10) {
    reasons.push("result summary is missing or too short");
  }

  for (const ref of env.createdObjects) {
    const o = proj.objects.get(ref);
    const v = proj.verifications.get(ref);
    const a = proj.artifacts.get(ref);
    const sk = proj.skills.get(ref);
    if (!o && !v && !a && !sk) {
      rejectedOutputs.push(ref);
      reasons.push(`created object ${ref} does not exist in campaign state`);
    } else if (o?.epistemicStatus && VERIFIER_ONLY_STATUSES.includes(o.epistemicStatus)) {
      // allowed ONLY if a verification record proves the core applied this transition
      const proved = [...proj.verifications.values()].some(
        (vv) => vv.targetId === o.id && vv.appliedTransitions?.some((t) => t.to === o.epistemicStatus),
      );
      if (!proved) {
        rejectedOutputs.push(ref);
        reasons.push(`object ${ref} claims verifier-only status ${o.epistemicStatus} without a matching verification — workers cannot self-promote (invariant C)`);
      } else {
        verifiedOutputs.push(ref);
      }
    } else {
      verifiedOutputs.push(ref);
    }
  }

  for (const ref of env.createdArtifacts) {
    if (!proj.artifacts.has(ref) && !proj.objects.has(ref)) reasons.push(`artifact ${ref} not registered`);
  }
  for (const ref of env.evidence) {
    // evidence entries must be refs; prose entries are tolerated as commentary (refs are checked above)
    const looksLikeRef = /^[a-z_]+:[a-z]+_\d+$/.test(ref) || /^[a-z_.-]+:[a-zA-Z0-9._-]+$/.test(ref);
    if (looksLikeRef && !proj.objects.has(ref) && !proj.verifications.has(ref) && !proj.artifacts.has(ref) && !proj.skills.has(ref)) {
      reasons.push(`evidence ${ref} does not exist`);
    }
  }

  const required = task.expectedOutputs.requiredObjectTypes ?? [];
  for (const type of required) {
    const has = env.createdObjects.some((ref) => proj.objects.get(ref)?.type === type);
    if (!has && env.status !== "failure") {
      reasons.push(`output contract requires at least one object of type "${type}"`);
    }
  }

  if (env.status === "failure" && env.blockers.length === 0 && env.openQuestions.length === 0) {
    reasons.push("failure result must report blockers or open questions (negative results are first-class, §2.5)");
  }

  return {
    accepted: reasons.length === 0,
    verifiedOutputs,
    rejectedOutputs,
    reasons,
    evidenceRefs: env.evidence.slice(0, 8),
  };
}
