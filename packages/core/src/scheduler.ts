// scheduler.ts — round-based workflow engine (spec §10, §38, §39).
// Deterministic core scheduling: phases open when the previous one settles.
// The semantics stay as simple as the orchestrator pseudo-code in §39.
import type { TaskSpec, VerifierDefinition, ResearchObject } from "@research-os/contracts";
import type { CampaignProjection, ResearchCore } from "./core.js";
import { expireLeases, queuedTasks } from "./taskService.js";
import { completedCriteria, markCompleted } from "./campaignService.js";

export const PHASES = ["ground", "generate", "critique", "test", "consolidate"] as const;
export type Phase = (typeof PHASES)[number];

const TERMINAL = new Set(["accepted", "rejected", "failed"]);

/** Quality-diversity archive: derived at replay from branches + accepted tasks (never persisted). */
export interface QDNiche {
  key: string;
  branchId: string;
  score: number;
}
export function qdArchive(proj: CampaignProjection): Map<string, QDNiche> {
  const niches = new Map<string, QDNiche>();
  for (const b of proj.branches.values()) {
    const key = [...b.methodTags].map((t) => t.toLowerCase()).sort().join("+") || "untagged";
    const score = b.acceptedCount * (1 + [...proj.verifications.values()].filter((v) => v.targetId && [...proj.objects.values()].some((o) => o.id === v.targetId && o.branchId === b.id)).length * 0.1);
    const incumbent = niches.get(key);
    if (!incumbent || score > incumbent.score) niches.set(key, { key, branchId: b.id, score });
  }
  return niches;
}

/** Stagnation detection over the last two closed rounds (deterministic from events). */
export function stagnationSignals(proj: CampaignProjection): { stagnant: boolean; signals: string[] } {
  const signals: string[] = [];
  const closed = [...proj.tasks.values()].reduce<Map<number, { accepted: number; total: number }>>((acc, t) => {
    const row = acc.get(t.round) ?? { accepted: 0, total: 0 };
    row.total += 1;
    if (t.status === "accepted") row.accepted += 1;
    acc.set(t.round, row);
    return acc;
  }, new Map());
  const rounds = [...closed.keys()].sort((a, b) => b - a).slice(0, 2);
  if (rounds.length === 2 && closed.get(rounds[0])!.accepted === 0 && closed.get(rounds[1])!.accepted === 0) signals.push("two rounds without any accepted task");
  // repeated thesis fingerprints
  const fp = new Map<string, number>();
  for (const b of proj.branches.values()) {
    const k = b.thesis.toLowerCase().split(/\s+/).slice(0, 8).join(" ");
    fp.set(k, (fp.get(k) ?? 0) + 1);
  }
  for (const [k, n] of fp) if (n >= 3) signals.push(`3+ branches share the thesis opening "${k.slice(0, 50)}…"`);
  // no epistemic progress over the last two rounds
  const recentVerified = [...proj.verifications.values()].filter((v) => v.status !== "pending" && (v.appliedTransitions?.length ?? 0) > 0).length;
  if (proj.state.currentRound >= 3 && recentVerified === 0) signals.push("no verifier-driven claim transitions at all");
  return { stagnant: signals.length >= 2, signals };
}

export interface SchedulerDeps {
  core: ResearchCore;
  /** campaign-scoped module resolution (verifiers, diversity, roles) */
  modulesFor: (proj: CampaignProjection) => { verifiers: VerifierDefinition[]; diversityDescriptors: string[]; roles: string[] };
  /** spawn a headless worker; resolves once the process is launched */
  spawnWorker?: (proj: CampaignProjection, alias: string, role?: string) => Promise<void>;
  /** notify humans/workers over the mesh (optional) */
  notify?: (proj: CampaignProjection, message: string) => void;
  /** count of currently running headless runs per campaign */
  runningHeadless?: (proj: CampaignProjection) => number;
}

export function campaignRoom(campaignId: string): string {
  return `campaign.${campaignId.replace("campaign:", "").replaceAll("_", "-")}`;
}

export class Scheduler {
  private lastGateNoticeRound = new Map<string, number>();

  constructor(private readonly deps: SchedulerDeps) {}

  tick(): void {
    for (const proj of this.deps.core.listCampaigns()) {
      try {
        // lease sweeping runs for every campaign, even terminal ones (cleanup)
        expireLeases(this.deps.core, proj);
        if (proj.state.status !== "running") continue;
        this.checkStop(proj);
        if (proj.state.status !== "running") continue;
        this.ensureRound(proj);
        this.maybeSpawnWorkers(proj);
      } catch (err) {
        process.stderr.write(`[scheduler] tick error on ${proj.state.id}: ${String(err)}\n`);
      }
    }
  }

  private checkStop(proj: CampaignProjection): void {
    const criteria = completedCriteria(proj);
    const s = proj.state;
    const stop = s.stop;
    const semantics = stop.successSemantics ?? "any";
    const total = s.objective.successCriteria.length;
    const successMet = semantics === "all" ? criteria.length === total : criteria.length > 0;
    if (successMet && stop.onSuccess) {
      // V0.3 gates: success cannot complete the campaign before the lab actually ran
      const round = s.currentRound;
      const minRounds = stop.minRounds ?? 1;
      const needCycle = stop.requireCycle === true;
      const hasCritique = [...proj.tasks.values()].some((t) => t.phase === "critique" && t.status === "accepted");
      const hasTest = [...proj.tasks.values()].some((t) => t.phase === "test" && t.status === "accepted");
      const gated = round < minRounds || (needCycle && !(hasCritique && hasTest));
      if (gated) {
        if ((this.lastGateNoticeRound.get(s.id) ?? 0) < round) {
          this.lastGateNoticeRound.set(s.id, round);
          const why = round < minRounds ? `round ${round} < minRounds ${minRounds}` : "critique+test cycle not yet accepted";
          this.deps.notify?.(proj, `Success criteria met but cycle gate active (${why}) — research continues.`);
        }
      } else {
        markCompleted(this.deps.core, proj, criteria);
        this.deps.notify?.(proj, `Campaign completed — success criteria satisfied (${criteria.map((c) => c.type + ":" + c.value).join(", ")}). Report available.`);
        return;
      }
    }
    const st = proj.state;
    const exhausted =
      s.budgets.consumed.agentRuns >= s.budgets.limits.maxAgentRuns ||
      s.budgets.consumed.tasksCreated >= s.budgets.limits.maxTasks ||
      s.budgets.consumed.experiments >= s.budgets.limits.maxExperiments ||
      (s.budgets.consumed.startedAt !== undefined && Date.now() - Date.parse(s.budgets.consumed.startedAt) > s.budgets.limits.wallClockMinutes * 60_000);
    const outOfRounds = s.currentRound > s.budgets.limits.maxRounds;
    const stalled = s.noProgressRounds >= s.stop.noProgressRounds;
    if ((exhausted || outOfRounds || stalled) && s.stop.onBudgetExhausted) {
      const reason = exhausted ? "budget exhausted" : outOfRounds ? "max rounds reached" : `no progress for ${s.noProgressRounds} rounds`;
      this.deps.core.apply(proj, "campaign.stopped", { kind: "scheduler", id: "researchd" }, { reason });
      this.deps.notify?.(proj, `Campaign stopped: ${reason}.`);
    }
  }

  /** Open the next phase/round when the current one has settled. */
  private ensureRound(proj: CampaignProjection): void {
    if (proj.state.currentRound === 0) {
      this.openRound(proj, 1, "ground");
      return;
    }
    const round = proj.state.currentRound;
    const phaseTasks = (phase: Phase) => [...proj.tasks.values()].filter((t) => t.round === round && t.phase === phase);
    const settled = (tasks: TaskSpec[]) => tasks.every((t) => TERMINAL.has(t.status));

    const current = [...PHASES].reverse().find((ph) => phaseTasks(ph).length > 0) ?? "ground";
    if (!settled(phaseTasks(current))) return;

    // close the round when consolidate settles
    if (current === "consolidate") {
      const roundTasks = [...proj.tasks.values()].filter((t) => t.round === round);
      const accepted = roundTasks.filter((t) => t.status === "accepted").length;
      this.deps.core.apply(proj, "round.closed", { kind: "scheduler", id: "researchd" }, { round, accepted, noProgress: accepted === 0 });
      // V0.4.2: promote heavily-cited candidate skills to active
      for (const s of proj.skills.values()) {
        if (s.verificationState === "candidate" && (s.citations ?? 0) >= 2) {
          this.deps.core.apply(proj, "memory.skill_activated", { kind: "scheduler", id: "researchd" }, { skillId: s.id }, { correlationId: s.id });
          this.deps.notify?.(proj, `Skill activated (cited ${s.citations}x): ${s.name}`);
        }
      }
      this.openRound(proj, round + 1, "generate");
      return;
    }
    const next = PHASES[PHASES.indexOf(current) + 1];
    this.openRound(proj, round, next as Phase);
  }

  private openRound(proj: CampaignProjection, round: number, phase: Phase): void {
    const created = this.createPhaseTasks(proj, round, phase);
    if (created > 0) {
      this.deps.core.apply(proj, "round.opened", { kind: "scheduler", id: "researchd" }, { round, phase });
      const summary = [...proj.tasks.values()].filter((t) => t.round === round && t.phase === phase).map((t) => `${t.id}(${t.role})`).join(", ");
      this.deps.notify?.(proj, `Round ${round} phase "${phase}" opened: ${created} task(s) — ${summary}. Workers: claim via research_claim_task.`);
      return;
    }
    // empty phase: skip forward instantly (never block the machine on an empty phase)
    const idx = PHASES.indexOf(phase);
    if (phase === "consolidate" || idx >= PHASES.length - 1) {
      // nothing to consolidate — close the round
      const roundTasks = [...proj.tasks.values()].filter((t) => t.round === round);
      const accepted = roundTasks.filter((t) => t.status === "accepted").length;
      this.deps.core.apply(proj, "round.closed", { kind: "scheduler", id: "researchd" }, { round, accepted, noProgress: accepted === 0 });
      this.openRound(proj, round + 1, "generate");
      return;
    }
    this.openRound(proj, round, PHASES[idx + 1] as Phase);
  }

  private createPhaseTasks(proj: CampaignProjection, round: number, phase: Phase): number {
    const core = this.deps.core;
    const objective = proj.state.objective;
    const mkTask = (input: Omit<TaskSpec, "id" | "campaignId" | "createdAt" | "status" | "attempts">): TaskSpec => {
      const id = core.nextId(proj, "task");
      const guidance = proj.state.modulePrompts?.[input.phase as string];
      const goal = guidance ? `${input.goal}\n\nModule guidance (${proj.state.modules.join(", ") || "module"}):\n${guidance}` : input.goal;
      const task: TaskSpec = { ...input, goal, id, campaignId: proj.state.id, createdAt: new Date().toISOString(), status: "queued", attempts: 0 };
      core.apply(proj, "task.created", { kind: "scheduler", id: "researchd" }, { task });
      return task;
    };
    const moduleSet = this.deps.modulesFor(proj);
    const verifierCatalog = moduleSet.verifiers
      .map((v) => `${v.id} — ${v.label}: ${v.description} inputs: ${JSON.stringify(v.inputs)}`)
      .join("\n");

    let count = 0;
    if (phase === "ground") {
      mkTask({
        round, phase, type: "ground", role: "scout", priority: 10,
        goal: `Ground the campaign. Objective: ${objective.statement}\nMap: (1) known facts and definitions relevant to the objective, (2) known methods and baselines, (3) unresolved contradictions, (4) the most important open sub-questions. Record sources as source objects, facts as observations/claims (unverified), and sub-questions as question objects. Keep every object precise and referenceable.`,
        inputs: [], expectedOutputs: { description: "Grounding map with question objects", requiredObjectTypes: ["question"], requiresSummary: true },
        allowedTools: ["research_*"], budget: { maxMinutes: 20 }, leaseSeconds: proj.state.workers.leaseSeconds, seed: undefined,
      });
      count++;
      return count;
    }
    if (phase === "generate") {
      const allDescriptors = moduleSet.diversityDescriptors.length > 0 ? moduleSet.diversityDescriptors : ["analytic", "computational", "structural"];
      const descriptors = allDescriptors; // full list for round-robin overflow
      // V0.3.5 + V0.6.1: fill UNCOVERED descriptor niches first (QD-aware seeds)
      const covered = new Set<string>();
      for (const b of proj.branches.values()) for (const tag of b.methodTags) covered.add(tag.toLowerCase());
      const uncovered = allDescriptors.filter((d) => !covered.has(String(d).toLowerCase()));
      const seedPool = uncovered.length > 0 ? uncovered : allDescriptors;
      // V0.6.3: paradigm-break task when stagnant — before normal generation
      const stag = stagnationSignals(proj);
      if (stag.stagnant) {
        mkTask({
          round, phase, type: "paradigm-break", role: "explorer", priority: 10, seed: "paradigm-shift",
          goal: `STAGNATION DETECTED (${stag.signals.join("; ")}). Break the pattern: propose an approach MAXIMALLY DISTANT from the dominant descriptors (${[...covered].slice(0, 6).join(", ")}). Change REPRESENTATION (not a variant): a different mathematical framing, a different computational lens, or an inverted assumption. Dominant approaches have stalled — do not refine them. Create a new branch + falsifiable hypothesis reflecting this shift.`,
          inputs: [],
          expectedOutputs: { description: "One paradigm-shifting branch + falsifiable hypothesis", requiredObjectTypes: ["branch", "hypothesis"], requiresSummary: true },
          allowedTools: ["research_*"], budget: { maxMinutes: 20 }, leaseSeconds: proj.state.workers.leaseSeconds,
        });
        this.deps.notify?.(proj, `Paradigm-break task scheduled (stagnation: ${stag.signals[0]}…).`);
        count++;
      }
      const activeBranches = [...proj.branches.values()].filter((b) => b.status === "active" || b.status === "seeded");
      const existingCount = proj.branches.size;
      let spawned = 0;
      if (round > 1) {
        // refine promising branches (exploitation)
        for (const b of activeBranches) {
          if (b.acceptedCount === 0) continue;
          mkTask({
            round, phase, type: "refine", role: "explorer", priority: 6, branchId: b.id,
            goal: `Refine branch ${b.id} (thesis: ${b.thesis}). Push the strongest direction one concrete step further: sharpen the main claim, add derivable consequences, or prepare a cheap falsification test. Create refined hypothesis/claim objects linked to this branch.`,
            inputs: [...proj.objects.values()].filter((o) => o.branchId === b.id && ["claim", "hypothesis"].includes(o.type)).slice(0, 4).map((o) => o.id),
            expectedOutputs: { description: "Refined claim or hypothesis on the branch", requiredObjectTypes: ["hypothesis"], requiresSummary: true },
            allowedTools: ["research_*"], budget: { maxMinutes: 15 }, leaseSeconds: proj.state.workers.leaseSeconds,
          });
          spawned++;
        }
      }
      // blind exploration — fill up to blindGenerators per round while under maxBranches
      const want = proj.state.search.blindGenerators;
      for (let i = 0; i < want && existingCount + spawned < proj.state.search.maxBranches; i++) {
        const descriptor = i < seedPool.length ? seedPool[i] : descriptors[(round + i) % descriptors.length];
        mkTask({
          round, phase, type: "explore", role: "explorer", priority: 8, seed: descriptor,
          goal: `Open a NEW independent research branch using a "${descriptor}" approach. Objective: ${objective.statement}\nPropose: (1) a branch with a distinct thesis + method tags (research_create_branch), (2) at least one precise falsifiable hypothesis or claim on that branch. Be genuinely different from generic first ideas — your seed strategy is "${descriptor}". BLIND MODE: work independently, do not consult peers.`,
          inputs: objective.questions.slice(0, 3),
          expectedOutputs: { description: "One new branch + falsifiable hypothesis/claim", requiredObjectTypes: ["branch", "hypothesis"], requiresSummary: true },
          allowedTools: ["research_*"], budget: { maxMinutes: 15 }, leaseSeconds: proj.state.workers.leaseSeconds,
        });
        spawned++;
      }
      return spawned;
    }
    if (phase === "critique") {
      // one adversary per branch that produced claims this round or holds unverified claims
      const branchesWithClaims = new Map<string, ResearchObject[]>();
      for (const o of proj.objects.values()) {
        if (!["claim", "hypothesis"].includes(o.type)) continue;
        if (o.epistemicStatus && ["verified", "falsified"].includes(o.epistemicStatus)) continue;
        const bid = o.branchId ?? "(none)";
        const arr = branchesWithClaims.get(bid) ?? [];
        if (arr.length < 4) arr.push(o);
        branchesWithClaims.set(bid, arr);
      }
      for (const [bid, claims] of branchesWithClaims) {
        mkTask({
          round, phase, type: "critique", role: "adversary", priority: 7, branchId: bid === "(none)" ? undefined : bid,
          goal: `Adversarial critique. Attack these rival proposals:\n${claims.map((c) => `- ${c.id}: ${c.title} — ${JSON.stringify(c.content).slice(0, 300)}`).join("\n")}\nFind: hidden assumptions, counterexamples, ambiguity, missing definitions, cheap tests that would falsify them. Record observations (research_record_observation) and, where you can DEFEAT a claim cheaply, add contradicting evidence. Do not be polite — but be exact.`,
          inputs: claims.map((c) => c.id),
          expectedOutputs: { description: "Precise critique with observations/evidence", requiredObjectTypes: undefined, requiresSummary: true },
          allowedTools: ["research_*"], budget: { maxMinutes: 15 }, leaseSeconds: proj.state.workers.leaseSeconds,
        });
        count++;
      }
      return count;
    }
    if (phase === "test") {
      // one experimentalist per branch (or the unbranched group) holding live claims/hypotheses
      const branchesWithClaims = new Map<string, string[]>();
      for (const o of proj.objects.values()) {
        if (!["claim", "hypothesis"].includes(o.type)) continue;
        if (o.epistemicStatus === "falsified" || o.epistemicStatus === "verified") continue;
        const bid = o.branchId ?? "(unbranched)";
        const arr = branchesWithClaims.get(bid) ?? [];
        if (arr.length < 3) arr.push(o.id);
        branchesWithClaims.set(bid, arr);
      }
      for (const [bid, refs] of branchesWithClaims) {
        mkTask({
          round, phase, type: "experiment", role: "experimentalist", priority: 9, branchId: bid === "(unbranched)" ? undefined : bid,
          goal: `Design and RUN a cheap exact falsification experiment for branch ${bid} (hypotheses: ${refs.join(", ")}).\nIf needed, state the exact falsifiable claim first (research_create_claim), then write executable code under experiments/, run it, register outputs as artifacts (research_create_artifact), plan the experiment (research_create_experiment), and REQUEST deterministic verification with research_request_verification.\nAvailable verifiers:\n${verifierCatalog}\nPrefer exact arithmetic / deterministic checks over judgment. A confirmed counterexample must go through the verifier — never assert it yourself.`,
          inputs: refs,
          expectedOutputs: { description: "Executed experiment + verification request", requiredObjectTypes: ["experiment"], requiresSummary: true },
          allowedTools: ["research_*", "bash", "read", "write", "edit"], budget: { maxMinutes: 25 }, leaseSeconds: proj.state.workers.leaseSeconds,
        });
        count++;
      }
      return count;
    }
    if (phase === "consolidate") {
      mkTask({
        round, phase, type: "synthesize", role: "synthesizer", priority: 5,
        goal: `Consolidate round ${round}. Summarize: strongest results, new verified/falsified claims, failures worth remembering, and what changed in the branch portfolio. If you noticed a REUSABLE research procedure this round (what worked / what wasted effort), propose it as a skill candidate (research_propose_skill) with evidence refs. Record a decision object for the round's key strategic choice.`,
        inputs: [...proj.tasks.values()].filter((t) => t.round === round).slice(0, 8).map((t) => t.resultRef ?? t.id),
        expectedOutputs: { description: "Round synthesis + optional skill proposal", requiredObjectTypes: ["decision"], requiresSummary: true },
        allowedTools: ["research_*"], budget: { maxMinutes: 15 }, leaseSeconds: proj.state.workers.leaseSeconds,
      });
      count++;
      return count;
    }
    return count;
  }

  private maybeSpawnWorkers(proj: CampaignProjection): void {
    const want = proj.state.workers.autoSpawn;
    if (want <= 0 || !this.deps.spawnWorker) return;
    const queued = queuedTasks(proj);
    if (queued.length === 0) return;
    const running = this.deps.runningHeadless?.(proj) ?? 0;
    // V0.3.3: spawn role-specialized workers covering queued task roles
    const runningAliases = new Set(
      [...proj.agentRuns.values()].filter((r) => r.mode === "headless" && r.status === "running").map((r) => r.workerAlias),
    );
    const roleNeeds = [...new Set(queued.map((t) => t.role))].filter(
      (r) => ![...runningAliases].some((alias) => alias.endsWith(`-${r}`)),
    );
    let aliasSeq = proj.agentRuns.size + 1;
    let spawned = 0;
    for (let i = running; i < Math.min(want, queued.length); i++) {
      const role = roleNeeds.length > 0 ? roleNeeds[spawned % roleNeeds.length] : undefined;
      const alias = `w${proj.state.id.replace("campaign:", "")}-${aliasSeq++}`;
      void this.deps.spawnWorker(proj, alias, role).catch((err) => {
        process.stderr.write(`[scheduler] worker spawn failed: ${String(err)}\n`);
      });
      spawned++;
    }
  }
}

