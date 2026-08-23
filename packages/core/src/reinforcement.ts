// reinforcement.ts — RL-lite: outcomes become priors (v0.4).
//
// The system already records WHAT happened (events). This module turns those
// records into LEARNING SIGNALS:
//   - task outcome rewards (accepted/rejected + reason classes)
//   - skill utility updated by real outcomes (cited+accepted → up, cited+rejected → down,
//     time decay so stale skills fade)
//   - strategy priors: acceptance rate per (phase, descriptor) with a UCB-style
//     exploration bonus so nothing is starved by early bad luck
//   - audit rejection reasons as worker-visible feedback (avoid past mistakes)
//
// Not gradient RL — reward-weighted statistics that the scheduler and ContextPacks
// consume. Every signal is derived from event provenance (no invented data).
import type { CampaignProjection } from "./core.js";
import type { ResearchEvent } from "@research-os/contracts";

export interface TaskOutcome {
  taskId: string;
  round: number;
  phase: string;
  descriptor: string; // task seed / branch methodTag / strategy name
  role: string;
  accepted: boolean;
  rejectionClasses: string[]; // categorized audit reasons
  skillsUsed: string[];
  verifiedClaims: number; // verifier-passed claims this task produced
  minutes: number;
}

export interface SkillStats {
  name: string;
  cited: number;
  wins: number; // cited + task accepted
  losses: number; // cited + task rejected
  utility: number; // decayed win-rate in [-1, 1]
  lastUsed: string;
}

export interface StrategyStats {
  key: string; // "phase:descriptor"
  n: number;
  accepted: number;
  rate: number; // accepted / n
  ucb: number; // rate + sqrt(2 ln N / n) — exploration bonus
}

/** Classify an audit rejection reason into a compact, learnable class. */
export function classifyRejection(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("does not exist")) return "ref-not-found";
  if (r.includes("verifier-only") || r.includes("self-promote")) return "self-promotion";
  if (r.includes("output contract requires")) return "missing-required-object";
  if (r.includes("summary") || r.includes("too short")) return "weak-summary";
  if (r.includes("bound")) return "bound-mismatch";
  if (r.includes("evidence")) return "evidence-invalid";
  if (r.includes("artifact")) return "artifact-unregistered";
  return "other";
}

/** Extract task outcomes from a campaign projection (pure read). */
export function extractOutcomes(proj: CampaignProjection): TaskOutcome[] {
  const tasks = new Map<string, { round: number; phase: string; role: string; seed?: string; descriptor: string; accepted: boolean; rejectionClasses: string[]; skillsUsed: string[]; minutes: number }>();
  const envelopes = new Map<string, { skillsUsed: string[]; minutes?: number; createdObjects: string[] }>();
  const verifByCorrelation = new Map<string, number>(); // taskId -> passed verifications
  let vcount = new Map<string, number>();

  for (const e of proj.store.readAll()) {
    const p = e.payload as Record<string, unknown>;
    if (e.type === "task.created") {
      const t = p.task as { id: string; round: number; phase: string; role: string; seed?: string; branchId?: string };
      const branchTag = t.branchId ? (proj.branches.get(t.branchId)?.methodTags[0] ?? "") : "";
      tasks.set(t.id, { round: t.round, phase: t.phase, role: t.role, seed: t.seed, descriptor: String(t.seed ?? branchTag ?? t.role), accepted: false, rejectionClasses: [], skillsUsed: [], minutes: 0 });
    }
    if (e.type === "task.result_submitted") {
      const env = p.envelope as { taskId: string; skillsUsed?: string[]; resourceUsage?: { minutesUsed?: number }; createdObjects?: string[] };
      envelopes.set(env.taskId, { skillsUsed: env.skillsUsed ?? [], minutes: env.resourceUsage?.minutesUsed, createdObjects: env.createdObjects ?? [] });
    }
    if (e.type === "task.accepted") {
      const t = tasks.get(String(p.taskId));
      if (t) t.accepted = true;
    }
    if (e.type === "task.rejected") {
      const t = tasks.get(String(p.taskId));
      const reasons = (p.audit as { reasons?: string[] })?.reasons ?? [];
      if (t) t.rejectionClasses = reasons.map(classifyRejection);
    }
    if (e.type === "verification.passed" && e.correlationId) {
      vcount.set(e.correlationId, (vcount.get(e.correlationId) ?? 0) + 1);
    }
  }

  const out: TaskOutcome[] = [];
  for (const [id, t] of tasks) {
    if (!envelopes.has(id)) continue; // only submitted tasks have outcomes
    const env = envelopes.get(id)!;
    out.push({
      taskId: id,
      round: t.round,
      phase: t.phase,
      descriptor: t.descriptor,
      role: t.role,
      accepted: t.accepted,
      rejectionClasses: t.rejectionClasses,
      skillsUsed: env.skillsUsed,
      verifiedClaims: vcount.get(id) ?? 0,
      minutes: env.minutes ?? 0,
    });
  }
  return out;
}

const DECAY_HALF_LIFE_DAYS = 14;

/** Update skill stats with decayed outcomes. Pure: returns new stats. */
export function updateSkillStats(prior: Map<string, SkillStats>, outcomes: TaskOutcome[], now = new Date()): Map<string, SkillStats> {
  const stats = new Map(prior);
  for (const o of outcomes) {
    for (const s of o.skillsUsed) {
      const st = stats.get(s) ?? { name: s, cited: 0, wins: 0, losses: 0, utility: 0, lastUsed: now.toISOString() };
      st.cited += 1;
      st.lastUsed = now.toISOString();
      if (o.accepted) st.wins += 1;
      else st.losses += 1;
      stats.set(s, st);
    }
  }
  // decayed utility: win-rate pulled toward 0 by age
  for (const st of stats.values()) {
    const ageDays = (now.getTime() - Date.parse(st.lastUsed)) / 86_400_000;
    const decay = Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
    const rate = st.cited > 0 ? st.wins / st.cited : 0.5;
    st.utility = decay * (2 * rate - 1); // in [-1, 1]
  }
  return stats;
}

/** Strategy priors with UCB exploration bonus (rate + sqrt(2 ln N / n)). */
export function strategyStats(outcomes: TaskOutcome[]): Map<string, StrategyStats> {
  const byKey = new Map<string, { n: number; accepted: number }>();
  for (const o of outcomes) {
    const key = `${o.phase}:${o.descriptor}`;
    const s = byKey.get(key) ?? { n: 0, accepted: 0 };
    s.n += 1;
    if (o.accepted) s.accepted += 1;
    byKey.set(key, s);
  }
  const total = [...byKey.values()].reduce((a, b) => a + b.n, 0);
  const out = new Map<string, StrategyStats>();
  for (const [key, s] of byKey) {
    const rate = s.accepted / s.n;
    const ucb = total > 0 && s.n > 0 ? rate + Math.sqrt((2 * Math.log(total)) / s.n) : 0.5;
    out.set(key, { key, n: s.n, accepted: s.accepted, rate, ucb });
  }
  return out;
}

/** Rank descriptors for a phase by UCB (used by the scheduler to seed generation). */
export function rankDescriptors(outcomes: TaskOutcome[], phase: string): string[] {
  const stats = strategyStats(outcomes.filter((o) => o.phase === phase));
  return [...stats.values()].sort((a, b) => b.ucb - a.ucb).map((s) => s.key.split(":")[1]);
}

/** Worker-visible feedback: the last N rejection classes to avoid repeating. */
export function recentRejectionFeedback(proj: CampaignProjection, n = 5): string[] {
  const outcomes = extractOutcomes(proj);
  const rejections = outcomes.filter((o) => !o.accepted).sort((a, b) => a.taskId.localeCompare(b.taskId));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rejections.reverse()) {
    for (const c of r.rejectionClasses) {
      if (!seen.has(c)) {
        seen.add(c);
        out.push(c);
      }
    }
  }
  return out.slice(0, n);
}
