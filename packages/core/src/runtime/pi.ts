// runtime/pi.ts — PiProcessAdapter: spawns headless `pi -p` workers in the
// campaign workspace (spec §6.2 process mode). Fresh context per run (§6.3).
// The adapter knows about the pi CLI; the research core does not (invariant G).
import { spawn, type ChildProcess } from "node:child_process";
import {
  type AgentHandle,
  type AgentRuntimeAdapter,
  type AgentRuntimeCapabilities,
  type AgentRuntimeState,
  type AgentSpawnSpec,
} from "@research-os/contracts";

export function piBin(): string {
  return process.env.PI_BIN ?? "pi";
}

/** Parse the LAST provider usage object from pi --mode json stdout (NDJSON events). */
export function parseUsageTokens(stdout: string): { total: number; estimated: boolean } {
  let last: Record<string, unknown> | null = null;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{") || !t.includes('"usage"')) continue;
    try {
      const ev = JSON.parse(t) as { usage?: Record<string, unknown> };
      if (ev.usage && typeof ev.usage === "object") {
        last = ev.usage;
      }
    } catch {
      /* skip */
    }
  }
  if (last) {
    const total = Number(last.input ?? 0) + Number(last.output ?? 0);
    if (total > 0) return { total, estimated: false };
  }
  // provider did not report usage — rough fallback, flagged
  return { total: Math.ceil(stdout.length / 4), estimated: true };
}

export const WORKER_BOOTSTRAP_PROMPT = `You are a ResearchOS research worker. Follow the research-worker skill.

Loop:
1. Call research_claim_task.
2. If a task is returned: execute it with your tools (read the ContextPack carefully), persist results with research_* tools, then submit the result envelope with research_submit_task_result.
3. If no task is returned: the scheduler may be between phases — claim again with waitSeconds: 120 (research_claim_task blocks server-side while waiting). NEVER use bash sleep to wait. If still nothing or the campaign is not running: stop and reply with a one-line status.

Rules: persist before announcing; never fabricate; failures are valuable — report blockers honestly; do not set verified/falsified yourself; never fabricate object ids — only reference objects you actually created.`;

interface RunRecord {
  handle: AgentHandle;
  child: ChildProcess;
  spec: AgentSpawnSpec;
  startedAt: number;
  stdout: string;
  exitCode?: number;
  settled: Promise<AgentRuntimeState>;
}

export class PiProcessAdapter implements AgentRuntimeAdapter {
  readonly id = "pi-process";
  private runs = new Map<string, RunRecord>();
  onSpawn?: (runId: string, spec: AgentSpawnSpec, pid?: number) => void;
  onExit?: (runId: string, state: AgentRuntimeState) => void;

  async capabilities(): Promise<AgentRuntimeCapabilities> {
    return { id: this.id, modes: ["headless", "interactive"], tools: ["research_*", "read", "write", "edit", "bash", "mesh_*"] };
  }

  spawn(spec: AgentSpawnSpec): Promise<AgentHandle> {
    const runId = `agent_run:headless-${Date.now().toString(36)}`;
    // V0.7.1: JSON mode exposes provider usage events → real token accounting
    const args = [
      "--mode", "json",
      "--provider", spec.model.provider,
      "--model", spec.model.model,
      "--thinking", spec.model.thinkingLevel ?? "max",
      "--name", `research-${spec.alias}`,
    ];
    const child = spawn(piBin(), args, {
      cwd: spec.workspaceDir,
      env: {
        ...process.env,
        ...spec.env,
        RESEARCH_URL: spec.env?.RESEARCH_URL ?? "http://127.0.0.1:8787",
        RESEARCH_WORKER_ALIAS: spec.alias,
        RESEARCH_CAMPAIGN: spec.campaignId,
        PI_MODEL: spec.model.model,
        PI_PROVIDER: spec.model.provider,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const handle: AgentHandle = { runId, alias: spec.alias, pid: child.pid };
    const rec: RunRecord = {
      handle,
      child,
      spec,
      startedAt: Date.now(),
      stdout: "",
      settled: new Promise((resolve) => {
        child.stdout?.on("data", (d: Buffer) => (rec.stdout += d.toString()));
        child.on("error", (err) => {
          rec.exitCode = 127;
          const state: AgentRuntimeState = { runId, status: "failed", exitCode: 127, stdout: `${rec.stdout}\nspawn error: ${String(err)}` };
          this.onExit?.(runId, state);
          resolve(state);
        });
        child.on("close", (code) => {
          rec.exitCode = code ?? 0;
          const tokens = parseUsageTokens(rec.stdout);
          const state: AgentRuntimeState = {
            runId,
            status: code === 0 ? "completed" : "failed",
            exitCode: code ?? 0,
            stdout: rec.stdout.slice(-20_000),
            tokensEstimate: tokens.total,
            tokensEstimated: tokens.estimated,
          };
          this.onExit?.(runId, state);
          resolve(state);
        });
      }),
    };
    this.runs.set(runId, rec);
    // deliver the bootstrap prompt via stdin (pi -p merges piped stdin into the initial prompt)
    child.stdin?.write(`${spec.taskPrompt}\n`);
    child.stdin?.end();
    // hard wall-clock kill for runaway workers
    const maxMs = (spec.maxRunMinutes ?? 25) * 60_000;
    const killTimer = setTimeout(() => {
      if (rec.exitCode === undefined) {
        process.stderr.write(`[pi-runtime] killing runaway worker ${spec.alias} after ${spec.maxRunMinutes ?? 25}min\n`);
        rec.child.kill("SIGTERM");
        setTimeout(() => rec.child.kill("SIGKILL"), 5000).unref?.();
      }
    }, maxMs);
    killTimer.unref?.();
    this.onSpawn?.(runId, spec, child.pid);
    return Promise.resolve(handle);
  }

  async inspect(handle: AgentHandle): Promise<AgentRuntimeState> {
    const rec = this.runs.get(handle.runId);
    if (!rec) return { runId: handle.runId, status: "failed", stdout: "unknown run" };
    const state = await Promise.race([
      rec.settled,
      new Promise<AgentRuntimeState>((resolve) => setTimeout(() => resolve({ runId: handle.runId, status: "running" }), 50)),
    ]);
    return state;
  }

  async terminate(handle: AgentHandle): Promise<void> {
    const rec = this.runs.get(handle.runId);
    if (rec && rec.exitCode === undefined) rec.child.kill("SIGKILL");
  }

  settledPromise(handle: AgentHandle): Promise<AgentRuntimeState> | null {
    return this.runs.get(handle.runId)?.settled ?? null;
  }

  activeCount(): number {
    let n = 0;
    for (const rec of this.runs.values()) if (rec.exitCode === undefined) n++;
    return n;
  }
}
