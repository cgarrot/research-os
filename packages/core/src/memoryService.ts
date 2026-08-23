// memoryService.ts — episodic/negative memory, skill candidates, intent retrieval (spec §12, §13, §15).
import type {
  ContextItem,
  MemoryItem,
  ResearchSkill,
  RetrievalIntent,
  ResultEnvelope,
  TaskSpec,
} from "@research-os/contracts";
import type { CampaignProjection, ResearchCore } from "./core.js";
import type { AuditResult } from "./audit.js";
import { nowIso, relevance, tokenize, truncate } from "./util.js";

/** Post-acceptance consolidation (spec §14): episode + failure memories. */
export function consolidateResult(core: ResearchCore, proj: CampaignProjection, task: TaskSpec, env: ResultEnvelope, audit: AuditResult): void {
  const memoryId = core.nextId(proj, "memory");
  const isFailure = !audit.accepted || env.status === "failure";
  const item: MemoryItem = {
    id: memoryId,
    kind: isFailure ? "negative" : "episodic",
    scope: task.branchId ? "branch-local" : "campaign-local",
    campaignId: proj.state.id,
    branchId: task.branchId,
    title: isFailure
      ? `Failure: ${task.type} (${task.role}) — ${truncate(env.summary, 90)}`
      : `Episode: ${task.type} (${task.role}) — ${truncate(env.summary, 90)}`,
    content: {
      round: task.round,
      phase: task.phase,
      accepted: audit.accepted,
      reasons: audit.reasons,
      blockers: env.blockers,
      openQuestions: env.openQuestions,
      createdObjects: env.createdObjects,
    },
    evidenceRefs: [env.id, ...env.evidence.slice(0, 3)],
    // trust comes from evidence, not self-judgment: failures stay loud, episodes modest
    verificationGrade: isFailure ? "audited-failure" : undefined,
    activation: isFailure ? 0.8 : 0.6,
    createdBy: env.workerAlias,
    createdAt: nowIso(),
  };
  core.apply(proj, "memory.episode_created", { kind: "auditor", id: "core-consolidation" }, { memory: item }, { correlationId: task.id });
}

export function proposeSkill(
  core: ResearchCore,
  proj: CampaignProjection,
  input: {
    name: string;
    activation: string[];
    procedure: string[];
    termination?: string[];
    warnings?: string[];
    evidenceRefs: string[];
    compatibleRoles?: string[];
    createdBy: string;
  },
): ResearchSkill {
  const id = core.nextId(proj, "skill");
  const skill: ResearchSkill = {
    id,
    name: input.name,
    scope: "campaign-local",
    activation: input.activation,
    procedure: input.procedure,
    termination: input.termination ?? [],
    warnings: input.warnings ?? [],
    antiPatterns: [],
    evidenceRefs: input.evidenceRefs,
    compatibleDomains: proj.state.modules,
    compatibleRoles: input.compatibleRoles ?? [],
    verificationState: "candidate", // never auto-activated (§13.4)
    version: 1,
    createdBy: input.createdBy,
    createdAt: nowIso(),
  };
  core.apply(proj, "memory.skill_candidate_created", { kind: "worker", id: input.createdBy }, { skill }, {});
  // V0.2.2: also materialize as a graph object so result envelopes can reference skill:sk_N
  core.apply(proj, "object.created", { kind: "worker", id: input.createdBy }, {
    object: {
      id, campaignId: proj.state.id, type: "skill_object", title: `skill: ${input.name}`,
      content: { name: input.name, activation: input.activation, procedure: input.procedure, verificationState: "candidate" },
      tags: ["skill"], createdBy: input.createdBy, createdAt: nowIso(), updatedAt: nowIso(),
    },
  });
  return skill;
}

/** Intent-specific retrieval (spec §15.1) — never one generic rag_search. */
export function retrieve(proj: CampaignProjection, intent: RetrievalIntent, query: string, k = 5): ContextItem[] {
  const qt = tokenize(query);
  const scored: { item: ContextItem; score: number }[] = [];

  const objItems = (types: string[], gradeBoost: (o: { epistemicStatus?: string; tags: string[]; verificationGrade?: string }) => number) => {
    for (const o of proj.objects.values()) {
      if (!types.includes(o.type) && types.length > 0) continue;
      const base = relevance(qt, `${o.title} ${JSON.stringify(o.content)}`);
      if (base <= 0 && qt.length > 0) continue;
      scored.push({
        item: { ref: o.id, title: o.title, snippet: truncate(JSON.stringify(o.content), 240), epistemicStatus: o.epistemicStatus },
        score: base + gradeBoost(o) + recencyBonus(o.updatedAt),
      });
    }
  };

  const memItems = (kinds: string[]) => {
    for (const m of proj.memories.values()) {
      if (!kinds.includes(m.kind)) continue;
      const base = relevance(qt, `${m.title} ${JSON.stringify(m.content)}`);
      scored.push({
        item: { ref: m.id, title: m.title, snippet: truncate(JSON.stringify(m.content), 240), epistemicStatus: m.verificationGrade },
        score: base + m.activation * 0.3 + recencyBonus(m.createdAt),
      });
    }
  };

  switch (intent) {
    case "retrieve_failures":
      memItems(["negative"]);
      objItems(["failure"], () => 0.1);
      break;
    case "retrieve_skills": {
      for (const s of proj.skills.values()) {
        const base = relevance(qt, `${s.name} ${s.activation.join(" ")} ${s.procedure.join(" ")}`);
        scored.push({ item: { ref: s.id, title: `skill[${s.verificationState}]: ${s.name}`, snippet: truncate(s.procedure.join(" → "), 240) }, score: base + (s.verificationState === "active" ? 0.2 : 0) });
      }
      break;
    }
    case "retrieve_evidence":
      objItems(["evidence"], (o) => (o.verificationGrade === "deterministic-exec" ? 0.25 : 0));
      break;
    case "retrieve_sources":
      objItems(["source"], () => 0);
      break;
    case "retrieve_known_methods":
      objItems(["method", "note"], () => 0);
      break;
    case "retrieve_analogies":
      objItems(["method", "hypothesis"], (o) => (o.tags.includes("cross-domain") ? 0.15 : 0));
      break;
    case "retrieve_similar_problems":
      objItems(["question", "hypothesis", "claim"], () => 0);
      break;
    case "retrieve_all":
    default:
      objItems([], () => 0);
      memItems(["negative", "episodic", "procedural"]);
      break;
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.item);
}

function recencyBonus(iso: string): number {
  const ageH = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (!Number.isFinite(ageH)) return 0;
  return Math.max(0, 0.1 - ageH * 0.002);
}

/** Retrieval profile per role for ContextPack extras (spec §15.5). */
export function skillsForRole(proj: CampaignProjection, role: string, query: string, k = 3): ContextItem[] {
  const items = retrieve(proj, "retrieve_skills", `${role} ${query}`, k * 2);
  const roleMatch = items.filter((i) => i.title.includes(role));
  return [...new Map([...roleMatch, ...items].map((i) => [i.ref, i])).values()].slice(0, k);
}
