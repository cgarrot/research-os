// events.ts — append-only event envelope (spec §5.2) and the core event types (§5.3).

export type ActorKind = "system" | "worker" | "human" | "verifier" | "module" | "scheduler" | "auditor";

export interface ActorRef {
  kind: ActorKind;
  id: string; // e.g. "worker:explorer-1", "human:operator", "verifier:python-exact"
}

export interface ResearchEvent<T = Record<string, unknown>> {
  id: string; // "event:evt_<n>" monotonic per campaign
  campaignId: string;
  type: string;
  timestamp: string;
  actor: ActorRef;
  correlationId?: string; // e.g. taskId or agentRunId
  causationId?: string; // event id that caused this one
  payload: T;
  schemaVersion: number;
}

export const EVENT_TYPES = [
  "campaign.created",
  "campaign.started",
  "campaign.paused",
  "campaign.resumed",
  "campaign.completed",
  "campaign.stopped",
  "objective.versioned",
  "branch.created",
  "branch.stalled",
  "branch.parked",
  "branch.closed",
  "task.created",
  "task.leased",
  "task.running",
  "task.result_submitted",
  "task.accepted",
  "task.rejected",
  "task.failed",
  "task.lease_expired",
  "task.requeued",
  "hypothesis.proposed",
  "claim.created",
  "claim.status_changed",
  "evidence.attached",
  "observation.recorded",
  "experiment.planned",
  "experiment.completed",
  "verification.requested",
  "verification.passed",
  "verification.failed",
  "claim.flagged",
  "artifact.created",
  "source.ingested",
  "memory.episode_created",
  "memory.skill_candidate_created",
  "memory.skill_cited",
  "memory.skill_activated",
  "budget.consumed",
  "round.opened",
  "round.closed",
  "worker.spawned",
  "worker.exited",
  "job.created",
  "job.checkpoint",
  "job.completed",
  "job.failed",
  "human.intervention",
] as const;

export type CoreEventType = (typeof EVENT_TYPES)[number];
