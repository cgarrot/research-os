// jobs.ts — durable compute jobs (spec §8.6): long searches run OUTSIDE Pi turns.
// researchd spawns the process, captures stdout as an immutable artifact, applies a
// wall-clock kill, and emits replay-safe job events. Checkpoints are the job script's
// responsibility (convention: write them in its cwd); a crashed daemon marks running
// jobs `interrupted` on replay — workers relaunch and the script resumes.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { ComputeJob } from "@research-os/contracts";
import type { CampaignProjection, ResearchCore } from "@research-os/core";
import { registerArtifactBytes } from "@research-os/core";
import { nowIso } from "@research-os/core";

interface LiveJob {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  timer?: NodeJS.Timeout;
}

export class JobRunner {
  private live = new Map<string, LiveJob>();
  private seq = 0;

  constructor(
    private readonly core: ResearchCore,
    private readonly onExit?: (job: ComputeJob) => void,
  ) {}

  /** Mark running jobs interrupted (called from replay when a job event exists without a live child). */
  static replayInterruptions(core: ResearchCore): void {
    for (const proj of core.listCampaigns()) {
      for (const job of proj.jobs.values()) {
        if (job.status === "running") {
          core.apply(proj, "job.failed", { kind: "system", id: "researchd" }, {
            jobId: job.id, reason: "interrupted", exitCode: undefined,
          }, { correlationId: job.id });
        }
      }
    }
  }

  create(
    proj: CampaignProjection,
    input: { name: string; command: string[]; cwd?: string; wallSeconds?: number; createdBy: string },
  ): ComputeJob {
    const id = this.core.nextId(proj, "job");
    const cwdAbs = path.resolve(proj.workspaceDir, input.cwd ?? ".");
    if (!cwdAbs.startsWith(path.resolve(proj.workspaceDir))) throw new Error(`job cwd escapes workspace: ${input.cwd}`);
    mkdirSync(cwdAbs, { recursive: true });
    this.seq += 1;
    const job: ComputeJob = {
      id,
      campaignId: proj.state.id,
      name: input.name,
      command: input.command,
      cwd: cwdAbs,
      status: "running",
      startedAt: nowIso(),
      wallSeconds: input.wallSeconds ?? 3600,
      createdBy: input.createdBy,
    };
    this.core.apply(proj, "job.created", { kind: "worker", id: input.createdBy }, { job }, { correlationId: id });

    const child = spawn(input.command[0], input.command.slice(1), { cwd: cwdAbs });
    const rec: LiveJob = { child, stdout: "", stderr: "" };
    this.live.set(id, rec);
    job.pid = child.pid;

    child.stdout?.on("data", (d: Buffer) => {
      rec.stdout += d.toString();
      // PROGRESS lines update the projection metric without flooding events
      const lines = rec.stdout.split("\n").filter((l) => l.includes('"PROGRESS"') || l.startsWith("PROGRESS"));
      const last = lines[lines.length - 1];
      if (last) {
        const metric = last.replace(/^.*?(PROGRESS\s*)/, "").slice(0, 200);
        const j = proj.jobs.get(id);
        if (j && j.lastProgress !== metric) {
          this.core.apply(proj, "job.checkpoint", { kind: "system", id: "researchd" }, { jobId: id, metric }, { correlationId: id });
        }
      }
    });
    child.stderr?.on("data", (d: Buffer) => (rec.stderr += d.toString()));
    child.on("error", (err) => this.finish(proj, id, "failed", 127, `${rec.stdout}\n[spawn error] ${String(err)}`));

    if (job.wallSeconds && job.wallSeconds > 0) {
      rec.timer = setTimeout(() => {
        if (this.live.has(id)) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already dead */
          }
        }
      }, job.wallSeconds * 1000);
      rec.timer.unref?.();
    }
    child.on("close", (code) => {
      const killed = rec.timer !== undefined && code === null;
      this.finish(proj, id, killed ? "timeout" : code === 0 ? "completed" : "failed", code ?? -1, `${rec.stdout}${rec.stderr ? `\n[stderr]\n${rec.stderr}` : ""}`);
    });
    return job;
  }

  private finish(proj: CampaignProjection, id: string, status: ComputeJob["status"], exitCode: number, output: string): void {
    const rec = this.live.get(id);
    if (!rec) return;
    if (rec.timer) clearTimeout(rec.timer);
    this.live.delete(id);
    const job = proj.jobs.get(id);
    if (!job) return;
    // stdout → immutable artifact (spec §19: exact artifacts, not prose)
    const artifact = registerArtifactBytes(this.core, proj, Buffer.from(output, "utf8"), {
      logicalName: `job-${id}-${job.name.replace(/[^a-zA-Z0-9._-]+/g, "_")}.log`,
      mediaType: "text/plain",
      producer: `job:${id}`,
    });
    // metric: last RESULT json line if any
    const m = /\{"RESULT"[^\n]*\}/.exec(output) ?? /^RESULT\s*(.+)$/m.exec(output);
    const metric = m ? m[0].slice(0, 400) : job.lastProgress;
    if (status === "completed") {
      this.core.apply(proj, "job.completed", { kind: "system", id: "researchd" }, {
        jobId: id, exitCode, stdoutArtifactRef: artifact.id, metric,
      }, { correlationId: id });
    } else {
      this.core.apply(proj, "job.failed", { kind: "system", id: "researchd" }, {
        jobId: id, reason: status, exitCode, stdoutArtifactRef: artifact.id,
      }, { correlationId: id });
    }
    this.onExit?.(proj.jobs.get(id) as ComputeJob);
  }

  runningCount(campaignId?: string): number {
    let n = 0;
    for (const rec of this.live.values()) void rec;
    // count from projections so it survives lookups
    for (const proj of this.core.listCampaigns()) {
      if (campaignId && proj.state.id !== campaignId) continue;
      for (const j of proj.jobs.values()) if (j.status === "running" && this.live.has(j.id)) n++;
    }
    return n;
  }
}
