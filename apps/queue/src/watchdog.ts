// watchdog.ts — pipeline liveness monitor + staged self-healing (v2).
//
// Detects the production incident class of 2026-08-23T14:05Z: a running campaign
// with pending work whose event log goes silent because the scheduler died or
// ghost runs blocked autoSpawn — while the HTTP API stays perfectly healthy.
//
// Liveness signals per RUNNING campaign:
//   events.jsonl mtime (the durable truth) + task queue depth + worker leases
// Escalation ladder (with cooldowns):
//   1. WARN      — log loudly (one shot per incident)
//   2. PROBE     — check /v1/health scheduler heartbeat: dead scheduler ⇒ restart daemon
//   3. SIGTERM   — graceful daemon restart (state replays; workers keep running)
//   4. SIGKILL   — hard kill + respawn
// Circuit breaker: max 3 daemon restarts per hour per campaign incident; beyond
// that, mark the campaign parked for human review instead of flapping.
import { existsSync, statSync } from "node:fs";
import path from "node:path";

export interface WatchdogState {
  /** campaignId -> incident tracking */
  incidents: Record<
    string,
    {
      lastEventAt: number; // last observed events.jsonl mtime (ms)
      stage: "watch" | "warned" | "restarting" | "killing" | "parked";
      stageSince: number;
      restarts: number[]; // timestamps (ms) of daemon restarts attributed to this campaign
      note?: string;
    }
  >;
}

export interface WatchdogDecision {
  action: "none" | "warn" | "restart" | "kill" | "park";
  reason: string;
  campaignId: string;
  stage: WatchdogState["incidents"][string]["stage"];
}

export interface CampaignLiveness {
  campaignId: string;
  status: string;
  running: boolean;
  queuedTasks: number;
  leasedTasks: number;
  eventsFile: string;
  eventsMtimeMs: number;
}

export interface WatchdogConfig {
  /** a running campaign with pending work and no new events for this long ⇒ incident */
  idleThresholdMs: number;
  /** time allowed between escalation stages */
  stageCooldownMs: number;
  /** max daemon restarts attributed to one campaign per rolling hour */
  maxRestartsPerHour: number;
}

export const DEFAULT_WATCHDOG: WatchdogConfig = {
  idleThresholdMs: 10 * 60_000,
  stageCooldownMs: 5 * 60_000,
  maxRestartsPerHour: 3,
};

export class Watchdog {
  state: WatchdogState = { incidents: {} };

  constructor(private readonly cfg: WatchdogConfig = DEFAULT_WATCHDOG) {}

  /** Evaluate one campaign's liveness → next action (pure except stage mutation). */
  evaluate(live: CampaignLiveness, now: number): WatchdogDecision {
    const pending = live.queuedTasks > 0 || live.leasedTasks > 0;
    if (!live.running || !pending) {
      // healthy or nothing to do — clear any incident
      if (this.state.incidents[live.campaignId]) delete this.state.incidents[live.campaignId];
      return { action: "none", reason: "no pending work on a running campaign", campaignId: live.campaignId, stage: "watch" };
    }

    const age = now - live.eventsMtimeMs;
    let inc = this.state.incidents[live.campaignId];
    if (!inc) {
      inc = this.state.incidents[live.campaignId] = {
        lastEventAt: live.eventsMtimeMs,
        stage: "watch",
        stageSince: now,
        restarts: [],
      };
    }
    inc.lastEventAt = Math.max(inc.lastEventAt, live.eventsMtimeMs);
    const idleFor = now - inc.lastEventAt;

    const withinCooldown = now - inc.stageSince < this.cfg.stageCooldownMs;
    const restartsThisHour = inc.restarts.filter((t) => now - t < 3_600_000).length;

    // recovered? (events flowed again)
    if (live.eventsMtimeMs >= inc.lastEventAt && idleFor < this.cfg.idleThresholdMs && inc.stage !== "watch" && inc.stage !== "parked") {
      delete this.state.incidents[live.campaignId];
      return { action: "none", reason: "recovered — events flowing again", campaignId: live.campaignId, stage: "watch" };
    }

    if (idleFor < this.cfg.idleThresholdMs) {
      return { action: "none", reason: `idle ${Math.round(idleFor / 1000)}s < threshold`, campaignId: live.campaignId, stage: inc.stage };
    }

    // circuit breaker
    if (restartsThisHour >= this.cfg.maxRestartsPerHour) {
      inc.stage = "parked";
      inc.stageSince = now;
      inc.note = `circuit breaker: ${restartsThisHour} restarts/hour exhausted`;
      return { action: "park", reason: inc.note, campaignId: live.campaignId, stage: "parked" };
    }

    if (inc.stage === "watch") {
      inc.stage = "warned";
      inc.stageSince = now;
      return { action: "warn", reason: `silent ${Math.round(idleFor / 60_000)}min with ${live.queuedTasks} queued/${live.leasedTasks} leased`, campaignId: live.campaignId, stage: "warned" };
    }
    if (inc.stage === "warned" && !withinCooldown) {
      inc.stage = "restarting";
      inc.stageSince = now;
      inc.restarts.push(now);
      return { action: "restart", reason: `still silent after warn (${Math.round(idleFor / 60_000)}min) — SIGTERM daemon, replay resumes`, campaignId: live.campaignId, stage: "restarting" };
    }
    if (inc.stage === "restarting" && !withinCooldown) {
      inc.stage = "killing";
      inc.stageSince = now;
      inc.restarts.push(now);
      return { action: "kill", reason: `restart did not resume events — SIGKILL + respawn`, campaignId: live.campaignId, stage: "killing" };
    }
    if (inc.stage === "killing" && !withinCooldown) {
      inc.stage = "parked";
      inc.stageSince = now;
      inc.note = "kill+respawn failed to resume events — human review required";
      return { action: "park", reason: inc.note, campaignId: live.campaignId, stage: "parked" };
    }
    return { action: "none", reason: `stage ${inc.stage} within cooldown`, campaignId: live.campaignId, stage: inc.stage };
  }
}

/** Read a campaign workspace's events mtime; 0 when missing. */
export function eventsLiveness(workspacesRoot: string, campaignId: string, workspaceDir: string | undefined): { eventsFile: string; mtimeMs: number } {
  const eventsFile = workspaceDir
    ? path.join(workspaceDir, "state", "events.jsonl")
    : path.join(workspacesRoot, `${campaignId.replace("campaign:", "")}-unknown`, "state", "events.jsonl");
  if (!existsSync(eventsFile)) return { eventsFile, mtimeMs: 0 };
  return { eventsFile, mtimeMs: statSync(eventsFile).mtimeMs };
}
