// core.ts — the Research Core aggregate (spec §4.3): owns truth about campaigns,
// branches, research objects, tasks, verifications, budgets and events.
// Every mutation is an event; projections are rebuilt by replay at boot (§5).
import {
  type AgentRun,
  type ArtifactManifest,
  type CampaignSpec,
  type CampaignState,
  type ObjectiveSpec,
  type ResearchBranch,
  type ResearchEdge,
  type ResearchEvent,
  type ResearchObject,
  type ResearchSkill,
  type ResultEnvelope,
  type TaskSpec,
  type VerificationRecord,
  type MemoryItem,
  type ActorRef,
  canonicalJson,
  makeId,
} from "@research-os/contracts";
import { EventStore } from "./eventStore.js";
import { nowIso, randHex, readJson, sha256, writeJsonAtomic } from "./util.js";
import path from "node:path";

export interface CampaignProjection {
  state: CampaignState;
  store: EventStore;
  stateDir: string;
  workspaceDir: string;
  objects: Map<string, ResearchObject>;
  edges: Map<string, ResearchEdge>;
  branches: Map<string, ResearchBranch>;
  tasks: Map<string, TaskSpec>;
  verifications: Map<string, VerificationRecord>;
  memories: Map<string, MemoryItem>;
  skills: Map<string, ResearchSkill>;
  artifacts: Map<string, ArtifactManifest>;
  agentRuns: Map<string, AgentRun>;
  envelopes: Map<string, ResultEnvelope>;
  /** events processed per round+phase: round -> phase -> Set<taskId> terminal */
  seq: Map<string, number>; // type -> last seq
  eventSeq: number;
  idempotency: Map<string, string>; // key -> event id
  completedCriteria: { type: string; value: string; evidenceRef?: string }[];
}

export class ResearchCore {
  private campaigns = new Map<string, CampaignProjection>();
  private registryFile: string;
  private counter = 0;
  private listeners: ((campaignId: string, event: ResearchEvent) => void)[] = [];

  constructor(readonly rootDir: string) {
    this.registryFile = path.join(rootDir, "registry.json");
  }

  subscribe(fn: (campaignId: string, event: ResearchEvent) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  /** Boot: replay all campaign event logs. */
  load(): { campaigns: number; events: number } {
    const registry = readJson<{ campaigns: { id: string; dir: string }[] }>(this.registryFile);
    let events = 0;
    for (const entry of registry?.campaigns ?? []) {
      const stateDir = path.join(entry.dir, "state");
      const store = EventStore.open(stateDir);
      const log = store.readAll();
      if (log.length === 0) continue;
      const proj: CampaignProjection = emptyProjection(entry.id, stateDir, path.dirname(stateDir));
      for (const ev of log) {
        try {
          applyEvent(proj, ev);
          events++;
        } catch (err) {
          // A malformed event must not kill the daemon; report and continue.
          process.stderr.write(`[core] replay error in ${entry.id} event ${ev.id}: ${String(err)}\n`);
        }
      }
      proj.store = store;
      this.campaigns.set(entry.id, proj);
      const n = Number(entry.id.split("_").pop());
      if (Number.isFinite(n) && n > this.counter) this.counter = n;
    }
    return { campaigns: this.campaigns.size, events };
  }

  listCampaigns(): CampaignProjection[] {
    return [...this.campaigns.values()];
  }

  getCampaign(id: string): CampaignProjection | undefined {
    return this.campaigns.get(id);
  }

  requireCampaign(id: string): CampaignProjection {
    const c = this.campaigns.get(id);
    if (!c) throw new Error(`unknown campaign: ${id}`);
    return c;
  }

  /** Create a new campaign: allocate id, dirs, register, emit campaign.created. */
  createCampaign(spec: CampaignSpec, opts: { piPackageDir: string }): CampaignProjection {
    this.counter += 1;
    const id = makeId("campaign", this.counter);
    const dirName = `${id.replace("campaign:", "")}-${randHex(4)}`;
    const workspaceDir = path.join(this.rootDir, dirName);
    const stateDir = path.join(workspaceDir, "state");
    const store = EventStore.open(stateDir);
    const proj = emptyProjection(id, stateDir, workspaceDir);
    proj.store = store;
    this.campaigns.set(id, proj);
    this.persistRegistry(id, workspaceDir);
    return proj;
  }

  private persistRegistry(id: string, workspaceDir: string): void {
    const registry = readJson<{ campaigns: { id: string; dir: string }[] }>(this.registryFile) ?? {
      campaigns: [],
    };
    registry.campaigns.push({ id, dir: workspaceDir });
    writeJsonAtomic(this.registryFile, registry);
  }

  /** Append an event and apply it to the projection. Single write path. */
  apply(proj: CampaignProjection, type: string, actor: ActorRef, payload: Record<string, unknown>, meta?: { correlationId?: string; causationId?: string }): ResearchEvent {
    proj.eventSeq += 1;
    const event: ResearchEvent = {
      id: makeId("event", proj.eventSeq),
      campaignId: proj.state.id,
      type,
      timestamp: nowIso(),
      actor,
      correlationId: meta?.correlationId,
      causationId: meta?.causationId,
      payload,
      schemaVersion: 1,
    };
    proj.store.append(event);
    applyEvent(proj, event);
    for (const l of this.listeners) {
      try {
        l(proj.state.id, event);
      } catch {
        /* listener errors never break the core */
      }
    }
    return event;
  }

  /** Allocate the next readable id for a type inside a campaign. */
  nextId(proj: CampaignProjection, type: string): string {
    const seq = (proj.seq.get(type) ?? 0) + 1;
    proj.seq.set(type, seq);
    return makeId(type, seq);
  }

  idempotencyCheck(proj: CampaignProjection, key: string): string | null {
    return proj.idempotency.get(key) ?? null;
  }

  idempotencyRecord(proj: CampaignProjection, key: string, eventId: string): void {
    proj.idempotency.set(key, eventId);
  }
}

export function emptyProjection(id: string, stateDir: string, workspaceDir: string): CampaignProjection {
  const proj: CampaignProjection = {
    state: {
      id,
      title: "",
      status: "created",
      objective: emptyObjective(id),
      modules: [],
      modelPools: { defaultPool: [] },
      search: { policy: "round-robin", blindGenerators: 3, maxBranches: 8 },
      budgets: {
        limits: { maxAgentRuns: 100, maxTasks: 100, maxRounds: 5, maxExperiments: 20, wallClockMinutes: 120, maxTokensEstimate: 50_000_000 },
        consumed: { agentRuns: 0, tasksCreated: 0, experiments: 0, tokensEstimate: 0 },
      },
      autonomy: { level: "L3", humanApprovalRequiredFor: [] },
      workers: { autoSpawn: 0, leaseSeconds: 900 },
      stop: { onSuccess: true, onBudgetExhausted: true, noProgressRounds: 3 },
      verification: { requireIndependentAudit: true },
      currentRound: 0,
      noProgressRounds: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
    store: null as unknown as EventStore,
    stateDir,
    workspaceDir,
    objects: new Map(),
    edges: new Map(),
    branches: new Map(),
    tasks: new Map(),
    verifications: new Map(),
    memories: new Map(),
    skills: new Map(),
    artifacts: new Map(),
    agentRuns: new Map(),
    envelopes: new Map(),
    seq: new Map(),
    eventSeq: 0,
    idempotency: new Map(),
    completedCriteria: [],
  };
  return proj;
}

function emptyObjective(campaignId: string): ObjectiveSpec {
  return {
    id: `${campaignId}/o_1`,
    statement: "",
    questions: [],
    deliverables: [],
    successCriteria: [],
    constraints: [],
    exclusions: [],
    assumptions: [],
    riskClass: "low",
    version: 1,
  };
}

/** Deterministic replay of one event onto the projection (spec §5.1). */
export function applyEvent(proj: CampaignProjection, ev: ResearchEvent): void {
  const p = ev.payload as Record<string, never>;
  switch (ev.type) {
    case "campaign.created": {
      const spec = p.spec as unknown as CampaignSpec;
      proj.state.title = spec.title;
      proj.state.modules = spec.modules;
      proj.state.modelPools = spec.models;
      proj.state.search = spec.search;
      proj.state.budgets.limits = spec.budgets;
      proj.state.autonomy = spec.autonomy;
      proj.state.workers = spec.workers;
      proj.state.stop = spec.stop;
      proj.state.verification = spec.verification;
      proj.state.modulePrompts = spec.modulePrompts;
      proj.state.workspaceDir = proj.workspaceDir;
      break;
    }
    case "campaign.started":
      proj.state.status = "running";
      proj.state.budgets.consumed.startedAt ??= ev.timestamp;
      break;
    case "campaign.paused":
      proj.state.status = "paused";
      break;
    case "campaign.resumed":
      proj.state.status = "running";
      break;
    case "campaign.stopped":
      proj.state.status = "stopped";
      break;
    case "campaign.completed":
      proj.state.status = "completed";
      break;
    case "objective.versioned": {
      proj.state.objective = p.objective as unknown as ObjectiveSpec;
      break;
    }
    case "round.opened":
      proj.state.currentRound = Math.max(proj.state.currentRound, Number(p.round));
      proj.state.updatedAt = ev.timestamp;
      break;
    case "round.closed":
      if (p.noProgress === true) proj.state.noProgressRounds += 1;
      else proj.state.noProgressRounds = 0;
      proj.state.updatedAt = ev.timestamp;
      break;
    case "branch.created": {
      const b = p.branch as unknown as ResearchBranch;
      proj.branches.set(b.id, b);
      break;
    }
    case "branch.stalled":
    case "branch.parked":
    case "branch.closed": {
      const b = proj.branches.get(String(p.branchId));
      if (b) {
        b.status = ev.type === "branch.stalled" ? "stalled" : ev.type === "branch.parked" ? "parked" : "closed";
        b.updatedAt = ev.timestamp;
      }
      break;
    }
    case "task.created": {
      const t = p.task as unknown as TaskSpec;
      proj.tasks.set(t.id, t);
      proj.state.budgets.consumed.tasksCreated += 1;
      break;
    }
    case "task.leased": {
      const t = proj.tasks.get(String(p.taskId));
      if (t) {
        t.status = "leased";
        t.lease = { holder: String(p.holder), expiresAt: String(p.expiresAt), agentRunId: p.agentRunId ? String(p.agentRunId) : undefined };
      }
      if (p.agentRunId) {
        const run = proj.agentRuns.get(String(p.agentRunId));
        if (run) run.taskId = String(p.taskId);
      }
      break;
    }
    case "task.running": {
      const t = proj.tasks.get(String(p.taskId));
      if (t) t.status = "running";
      break;
    }
    case "task.result_submitted": {
      const env = p.envelope as unknown as ResultEnvelope;
      proj.envelopes.set(env.id, env);
      const t = proj.tasks.get(env.taskId);
      if (t) {
        t.status = "submitted";
        t.resultRef = env.id;
      }
      break;
    }
    case "task.accepted":
    case "task.rejected": {
      const t = proj.tasks.get(String(p.taskId));
      if (t) {
        t.status = ev.type === "task.accepted" ? "accepted" : "rejected";
        if (t.lease?.agentRunId) {
          const run = proj.agentRuns.get(t.lease.agentRunId);
          if (run && run.mode === "interactive") run.taskId = undefined;
        }
      }
      const env = t?.resultRef ? proj.envelopes.get(t.resultRef) : undefined;
      if (t && ev.type === "task.accepted") {
        t.branchId && bumpBranchCounts(proj, t.branchId, true);
        if (env?.status === "failure") proj.state.noProgressRounds += 0; // counted at round close
      }
      break;
    }
    case "task.failed": {
      const t = proj.tasks.get(String(p.taskId));
      if (t) {
        t.status = "failed";
        if (t.lease?.agentRunId) {
          const run = proj.agentRuns.get(t.lease.agentRunId);
          if (run && run.mode === "interactive") run.taskId = undefined;
        }
      }
      break;
    }
    case "task.lease_expired": {
      const t = proj.tasks.get(String(p.taskId));
      if (t && (t.status === "leased" || t.status === "running")) t.status = "expired";
      if (t?.lease?.agentRunId) {
        const run = proj.agentRuns.get(t.lease.agentRunId);
        if (run) run.taskId = undefined;
      }
      break;
    }
    case "task.requeued": {
      const t = proj.tasks.get(String(p.taskId));
      if (t) {
        t.status = "queued";
        t.lease = undefined;
        t.attempts += 1;
      }
      if (t?.lease?.agentRunId) {
        const run = proj.agentRuns.get(t.lease.agentRunId);
        if (run) run.taskId = undefined;
      }
      break;
    }
    case "object.created": {
      const o = p.object as unknown as ResearchObject;
      proj.objects.set(o.id, o);
      if (o.type === "skill_object") {
        // skills are their own registry mirrored from objects
      }
      break;
    }
    case "edge.created": {
      const e = p.edge as unknown as ResearchEdge;
      proj.edges.set(e.id, e);
      break;
    }
    case "claim.status_changed": {
      const o = proj.objects.get(String(p.objectId));
      if (o) {
        o.epistemicStatus = p.to as never;
        o.updatedAt = ev.timestamp;
      }
      break;
    }
    case "verification.requested": {
      const v = p.verification as unknown as VerificationRecord;
      proj.verifications.set(v.id, v);
      break;
    }
    case "verification.passed":
    case "verification.failed": {
      const v = proj.verifications.get(String(p.verificationId));
      if (v) {
        v.status = ev.type === "verification.passed" ? "passed" : "failed";
        v.output = p.output ? String(p.output) : undefined;
        v.exitCode = p.exitCode === undefined ? undefined : Number(p.exitCode);
        v.artifactRef = p.artifactRef ? String(p.artifactRef) : undefined;
        v.completedAt = ev.timestamp;
        v.appliedTransitions = (p.appliedTransitions as { from: string; to: string }[]) ?? [];
        if (p.verifiedDomain) v.verifiedDomain = p.verifiedDomain as never;
      }
      // attach the real verified domain to every claim this verification transitioned
      if (p.verifiedDomain) {
        const target = p.verifiedTargetId ? proj.objects.get(String(p.verifiedTargetId)) : undefined;
        if (!target) {
          // find via appliedTransitions + this verification's targetId stored at request time
          const rec = proj.verifications.get(String(p.verificationId));
          if (rec) {
            const t = proj.objects.get(rec.targetId);
            if (t) {
              t.content.verifiedDomain = p.verifiedDomain as never;
              t.content.verifiedAt = { verifierId: rec.verifierId, verificationId: rec.id, artifactRef: v?.artifactRef };
              t.updatedAt = ev.timestamp;
            }
          }
        }
      }
      break;
    }
    case "claim.flagged": {
      const o = proj.objects.get(String(p.objectId));
      if (o) {
        o.content.flaggedBound = true;
        o.content.flagDetail = (p.check as Record<string, unknown>)?.detail ?? String(p.reason ?? "");
        o.updatedAt = ev.timestamp;
      }
      break;
    }
    case "artifact.created": {
      const a = p.manifest as unknown as ArtifactManifest;
      proj.artifacts.set(a.id, a);
      break;
    }
    case "memory.episode_created": {
      const m = p.memory as unknown as MemoryItem;
      proj.memories.set(m.id, m);
      break;
    }
    case "memory.skill_candidate_created": {
      const s = p.skill as unknown as ResearchSkill;
      proj.skills.set(s.id, s);
      break;
    }
    case "memory.skill_cited": {
      const s = proj.skills.get(String(p.skillId));
      if (s) s.citations = (s.citations ?? 0) + 1;
      break;
    }
    case "memory.skill_activated": {
      const s = proj.skills.get(String(p.skillId));
      if (s) s.verificationState = "active";
      break;
    }
    case "budget.consumed": {
      const d = p.delta as unknown as Partial<{ agentRuns: number; experiments: number; tokensEstimate: number }>;
      proj.state.budgets.consumed.agentRuns += d.agentRuns ?? 0;
      proj.state.budgets.consumed.experiments += d.experiments ?? 0;
      proj.state.budgets.consumed.tokensEstimate += d.tokensEstimate ?? 0;
      break;
    }
    case "worker.spawned": {
      const r = p.run as unknown as AgentRun;
      proj.agentRuns.set(r.id, r);
      proj.state.budgets.consumed.agentRuns += 1;
      break;
    }
    case "worker.exited": {
      const r = proj.agentRuns.get(String(p.runId));
      if (r) {
        r.status = (p.status as AgentRun["status"]) ?? "completed";
        r.endedAt = ev.timestamp;
        r.summary = p.summary ? String(p.summary) : undefined;
        r.tokensEstimate = p.tokensEstimate === undefined ? undefined : Number(p.tokensEstimate);
        r.tokensEstimated = p.tokensEstimated === undefined ? undefined : Boolean(p.tokensEstimated);
      }
      break;
    }
    case "experiment.planned":
      proj.state.budgets.consumed.experiments += 1;
      break;
    default:
      break; // unknown event types ignored on replay (forward compat)
  }
  proj.state.updatedAt = ev.timestamp;
}

function bumpBranchCounts(proj: CampaignProjection, branchId: string, accepted: boolean): void {
  const b = proj.branches.get(branchId);
  if (!b) return;
  b.acceptedCount += accepted ? 1 : 0;
  b.updatedAt = nowIso();
}

export function objectiveHash(objective: ObjectiveSpec): string {
  const { contentHash: _drop, ...rest } = objective;
  return sha256(canonicalJson(rest));
}
