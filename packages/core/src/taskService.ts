// taskService.ts — claim / lease / release / submit pipeline (spec §9).
import {
  type ContextPack,
  type ResultEnvelope,
  type TaskSpec,
  type ActorRef,
} from "@research-os/contracts";
import type { CampaignProjection, ResearchCore } from "./core.js";
import { auditEnvelope, type AuditResult } from "./audit.js";
import { buildContextPack } from "./contextBuilder.js";
import { consolidateResult } from "./memoryService.js";
import { nowIso } from "./util.js";

const MAX_ATTEMPTS = 3;

export function queuedTasks(proj: CampaignProjection): TaskSpec[] {
  return [...proj.tasks.values()]
    .filter((t) => t.status === "queued")
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
}

/** Worker claims the next queued task (role affinity preferred). */
export function claimTask(
  core: ResearchCore,
  proj: CampaignProjection,
  opts: { workerAlias: string; role?: string; provider?: string; model?: string; mode?: "headless" | "interactive" },
): { task: TaskSpec; context: ContextPack } | null {
  let candidates = queuedTasks(proj);
  if (opts.role) {
    const matching = candidates.filter((t) => t.role === opts.role);
    if (matching.length > 0) candidates = matching;
  }
  const task = candidates[0];
  if (!task) return null;

  const workerActor: ActorRef = { kind: "worker", id: opts.workerAlias };
  const leaseSeconds = task.leaseSeconds || proj.state.workers.leaseSeconds;
  const expiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();

  // Reuse an active headless run (spawned by the scheduler) for this worker; else record a fresh run.
  let runId = [...proj.agentRuns.values()].find(
    (r) => r.workerAlias === opts.workerAlias && r.status === "running" && !r.taskId,
  )?.id;
  if (!runId) {
    runId = core.nextId(proj, "agent_run");
    core.apply(proj, "worker.spawned", { kind: "system", id: "researchd" }, {
      run: {
        id: runId,
        campaignId: proj.state.id,
        workerAlias: opts.workerAlias,
        mode: opts.mode ?? "interactive",
        provider: opts.provider ?? "zai",
        model: opts.model ?? "glm-5.3",
        startedAt: nowIso(),
        status: "running",
      },
    }, { correlationId: task.id });
  }

  core.apply(proj, "task.leased", workerActor, {
    taskId: task.id,
    holder: opts.workerAlias,
    expiresAt,
    agentRunId: runId,
  }, { correlationId: task.id, causationId: runId });

  core.apply(proj, "task.running", workerActor, { taskId: task.id, agentRunId: runId }, { correlationId: task.id });

  const context = buildContextPack(proj, task);
  return { task: proj.tasks.get(task.id) as TaskSpec, context };
}

export function releaseTask(core: ResearchCore, proj: CampaignProjection, taskId: string, holder: string, reason: string): "requeued" | "failed" | "noop" {
  const t = proj.tasks.get(taskId);
  if (!t || !(t.status === "leased" || t.status === "running") || t.lease?.holder !== holder) return "noop";
  return requeueOrFail(core, proj, t, reason);
}

function requeueOrFail(core: ResearchCore, proj: CampaignProjection, t: TaskSpec, reason: string): "requeued" | "failed" {
  if (t.attempts + 1 >= MAX_ATTEMPTS) {
    core.apply(proj, "task.failed", { kind: "system", id: "researchd" }, { taskId: t.id, reason }, { correlationId: t.id });
    return "failed";
  }
  core.apply(proj, "task.requeued", { kind: "system", id: "researchd" }, { taskId: t.id, reason, attempts: t.attempts + 1 }, { correlationId: t.id });
  return "requeued";
}

/** Lease sweeper: expired leases lose their task (crashed workers). */
export function expireLeases(core: ResearchCore, proj: CampaignProjection, now = Date.now()): TaskSpec[] {
  const expired: TaskSpec[] = [];
  for (const t of proj.tasks.values()) {
    if ((t.status === "leased" || t.status === "running") && t.lease && Date.parse(t.lease.expiresAt) < now) {
      core.apply(proj, "task.lease_expired", { kind: "system", id: "researchd" }, { taskId: t.id }, { correlationId: t.id });
      requeueOrFail(core, proj, t, "lease expired");
      expired.push(t);
    }
  }
  return expired;
}

export interface SubmitResultOutcome {
  taskId: string;
  envelopeId: string;
  accepted: boolean;
  audit: AuditResult;
  duplicate?: boolean;
}

export function submitResult(
  core: ResearchCore,
  proj: CampaignProjection,
  taskId: string,
  input: {
    workerAlias: string;
    status: "success" | "partial" | "failure";
    createdObjects: string[];
    createdArtifacts: string[];
    evidence: string[];
    openQuestions: string[];
    blockers: string[];
    summary: string;
    skillsUsed?: string[];
    minutesUsed?: number;
    tokensEstimate?: number;
    idempotencyKey?: string;
  },
): SubmitResultOutcome {
  const t = proj.tasks.get(taskId);
  if (!t) throw new Error(`unknown task: ${taskId}`);

  if (input.idempotencyKey) {
    const prior = core.idempotencyCheck(proj, input.idempotencyKey);
    if (prior) {
      const priorOutcome = t.resultRef ? proj.envelopes.get(t.resultRef) : undefined;
      if (priorOutcome && (t.status === "accepted" || t.status === "rejected")) {
        return {
          taskId,
          envelopeId: priorOutcome.id,
          accepted: t.status === "accepted",
          audit: { accepted: t.status === "accepted", verifiedOutputs: [], rejectedOutputs: [], reasons: ["duplicate submission — original outcome stands"], evidenceRefs: [] },
          duplicate: true,
        };
      }
    }
  }

  if (t.status !== "leased" && t.status !== "running" && t.status !== "submitted") {
    throw new Error(`task ${taskId} is ${t.status}, cannot accept result`);
  }
  if (t.lease && t.lease.holder !== input.workerAlias) {
    throw new Error(`task ${taskId} leased by ${t.lease.holder}, not ${input.workerAlias}`);
  }

  const envelopeId = core.nextId(proj, "decision");
  const envelope: ResultEnvelope = {
    id: envelopeId,
    taskId,
    agentRunId: t.lease?.agentRunId ?? "",
    workerAlias: input.workerAlias,
    status: input.status,
    createdObjects: input.createdObjects,
    createdArtifacts: input.createdArtifacts,
    evidence: input.evidence,
    openQuestions: input.openQuestions,
    blockers: input.blockers,
    resourceUsage: { minutesUsed: input.minutesUsed, tokensEstimate: input.tokensEstimate },
    summary: input.summary,
    submittedAt: nowIso(),
    idempotencyKey: input.idempotencyKey,
  };

  core.apply(proj, "task.result_submitted", { kind: "worker", id: input.workerAlias }, { envelope }, { correlationId: taskId });

  const audit = auditEnvelope(proj, t, envelope);
  core.apply(proj, audit.accepted ? "task.accepted" : "task.rejected", { kind: "auditor", id: "core-audit" }, {
    taskId,
    envelopeId,
    audit: { accepted: audit.accepted, reasons: audit.reasons, verifiedOutputs: audit.verifiedOutputs, rejectedOutputs: audit.rejectedOutputs },
  }, { correlationId: taskId });

  if (input.tokensEstimate) {
    core.apply(proj, "budget.consumed", { kind: "worker", id: input.workerAlias }, { delta: { tokensEstimate: input.tokensEstimate }, taskId }, { correlationId: taskId });
  }
  // interactive task-runs close at submission; headless session runs close when the process exits
  const linkedRun = t.lease?.agentRunId ? proj.agentRuns.get(t.lease.agentRunId) : undefined;
  if (linkedRun && linkedRun.mode === "interactive") {
    core.apply(proj, "worker.exited", { kind: "system", id: "researchd" }, { runId: linkedRun.id, status: "completed", tokensEstimate: input.tokensEstimate }, { correlationId: taskId });
  }

  consolidateResult(core, proj, proj.tasks.get(taskId) as TaskSpec, envelope, audit);

  // V0.4.2: skill citations (counted on accepted results only)
  if (audit.accepted) {
    for (const sid of input.skillsUsed ?? []) {
      if (proj.skills.has(sid)) {
        core.apply(proj, "memory.skill_cited", { kind: "worker", id: input.workerAlias }, { skillId: sid, taskId }, { correlationId: taskId });
      }
    }
  }

  if (input.idempotencyKey) {
    core.idempotencyRecord(proj, input.idempotencyKey, envelopeId);
  }

  return { taskId, envelopeId, accepted: audit.accepted, audit };
}
