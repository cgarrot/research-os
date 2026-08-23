// main.ts — researchd daemon entry. One process, logical services (spec §2.10, §4.2).
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync } from "node:fs";
import {
  ResearchCore,
  Scheduler,
  loadModules,
  verifiersForCampaign,
  PiMeshTransportAdapter,
  PiProcessAdapter,
  WORKER_BOOTSTRAP_PROMPT,
  campaignRoom,
  releaseTask,
  globalStorePaths,
  loadMemoryStore,
  loadSkillStore,
  memoryHash,
  setGlobalContextSources,
  type GlobalMemoryEntry,
  type GlobalSkillEntry,
} from "@research-os/core";
import { handleRequest, sseStream } from "./server.js";
import { JobRunner } from "./jobs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../.."); // apps/researchd/dist -> repo root

const PORT = Number(process.env.RESEARCH_PORT ?? 8787);
const HOME = process.env.RESEARCH_HOME ?? path.join(ROOT, "workspaces");
const MODULES_DIR = process.env.RESEARCH_MODULES ?? path.join(ROOT, "modules");
const PI_PACKAGE_DIR = process.env.RESEARCH_PI_PACKAGE ?? path.join(ROOT, "pi", "research-os-pi");
const TICK_MS = Number(process.env.RESEARCH_TICK_MS ?? 3000);
const MESH_ALIAS = process.env.RESEARCH_MESH_ALIAS ?? "researchd";

process.stderr.write(`[researchd] root=${ROOT} home=${HOME} modules=${MODULES_DIR} pi=${PI_PACKAGE_DIR}\n`);

const core = new ResearchCore(HOME);
const loaded = core.load();
process.stderr.write(`[researchd] replayed ${loaded.events} events across ${loaded.campaigns} campaign(s)\n`);

const modules = loadModules([MODULES_DIR]);
process.stderr.write(`[researchd] modules: ${modules.map((m) => `${m.manifest.id}(${m.verifiers.length} verifiers)`).join(", ") || "none"}\n`);

// ---- durable compute jobs (novelty layer §8.6)
const jobRunner = new JobRunner(core, (job) => {
  process.stderr.write(`[job] ${job.id} ${job.status}${job.metric ? ` metric=${job.metric.slice(0, 80)}` : ""}\n`);
});
// replay-honesty: jobs still running with no live child were interrupted by a crash
JobRunner.replayInterruptions(core);

// ---- mesh transport (same broker as all Pi workers; transport only — invariant B)
const mesh = new PiMeshTransportAdapter((frame) => {
  process.stderr.write(`[mesh] ${frame.type} from ${frame.from}: ${String(frame.body ?? "").slice(0, 200)}\n`);
});
void mesh.connect({ alias: MESH_ALIAS, rooms: ["researchos", ...core.listCampaigns().map((p) => campaignRoom(p.state.id))] });

// ---- pi runtime adapter (headless workers)
const runtime = new PiProcessAdapter();
const adapterToRun = new Map<string, { campaignId: string; runId: string }>();
runtime.onSpawn = (adapterRunId, spec, pid) => {
  const proj = core.getCampaign(spec.campaignId);
  if (!proj) return;
  const runId = core.nextId(proj, "agent_run");
  adapterToRun.set(adapterRunId, { campaignId: spec.campaignId, runId });
  core.apply(proj, "worker.spawned", { kind: "scheduler", id: "researchd" }, {
    run: {
      id: runId,
      campaignId: spec.campaignId,
      workerAlias: spec.alias,
      mode: "headless",
      provider: spec.model.provider,
      model: spec.model.model,
      pid,
      startedAt: new Date().toISOString(),
      status: "running",
    },
  });
  process.stderr.write(`[researchd] spawned headless worker ${spec.alias} (pid ${pid}) run=${runId}\n`);
};
runtime.onExit = (adapterRunId, state) => {
  const link = adapterToRun.get(adapterRunId);
  adapterToRun.delete(adapterRunId);
  if (!link) return;
  const proj = core.getCampaign(link.campaignId);
  if (!proj) return;
  core.apply(proj, "worker.exited", { kind: "system", id: "researchd" }, {
    runId: link.runId,
    status: state.status === "completed" ? "completed" : "failed",
    summary: state.stdout?.slice(-2000),
    tokensEstimate: state.tokensEstimate,
    tokensEstimated: state.tokensEstimated,
  });
  // V0.7.1: real token accounting into the campaign budget
  if (state.tokensEstimate && state.tokensEstimate > 0) {
    core.apply(proj, "budget.consumed", { kind: "system", id: "researchd" }, {
      delta: { tokensEstimate: state.tokensEstimate },
      source: state.tokensEstimated ? "estimated-fallback" : "provider-usage",
    }, { correlationId: link.runId });
  }
  process.stderr.write(`[researchd] headless worker exited run=${link.runId} status=${state.status}\n`);
  // V0.2.3: a worker that died WITHOUT submitting requeues its task immediately
  const dead = proj.agentRuns.get(link.runId);
  if (dead?.taskId) {
    const t = proj.tasks.get(dead.taskId);
    if (t && (t.status === "leased" || t.status === "running") && t.lease?.holder === dead.workerAlias) {
      try {
        releaseTask(core, proj, t.id, dead.workerAlias, "worker exited without submitting");
        process.stderr.write(`[researchd] worker died mid-task — requeued ${t.id}\n`);
      } catch (err) {
        process.stderr.write(`[researchd] requeue failed for ${t.id}: ${String(err)}\n`);
      }
    }
  }
};

// ---- scheduler
const scheduler = new Scheduler({
  core,
  modulesFor: (proj) => {
    const set = verifiersForCampaign(modules, proj.state.modules);
    const manifests = modules.filter((m) => proj.state.modules.includes(m.manifest.id));
    return {
      verifiers: set,
      diversityDescriptors: manifests.flatMap((m) => m.manifest.diversityDescriptors),
      roles: manifests.flatMap((m) => m.manifest.roles.map((r) => r.name)),
    };
  },
  spawnWorker: async (proj, alias, role) => {
    const pool = proj.state.modelPools.defaultPool[0];
    if (!pool) throw new Error("campaign has no model pool");
    const maxRunMinutes = proj.state.workers.maxRunMinutes ?? Math.min(proj.state.budgets.limits.wallClockMinutes, 720);
    await runtime.spawn({
      campaignId: proj.state.id,
      workspaceDir: proj.workspaceDir,
      alias,
      role: "worker",
      model: { provider: pool.provider, model: pool.model, thinkingLevel: pool.thinkingLevel },
      taskPrompt: role ? `${WORKER_BOOTSTRAP_PROMPT}\n\nYour dedicated ROLE is: ${role}. Prefer tasks of this role (your claims default to its role).` : WORKER_BOOTSTRAP_PROMPT,
      mode: "headless",
      maxRunMinutes,
      env: { RESEARCH_URL: `http://127.0.0.1:${PORT}`, RESEARCH_WORKER_ALIAS: alias, RESEARCH_CAMPAIGN: proj.state.id, RESEARCH_WORKER_ROLE: role ?? "" },
    });
  },
  notify: (proj, message) => {
    void mesh.broadcast(campaignRoom(proj.state.id), message);
    process.stderr.write(`[notify/${proj.state.id}] ${message}\n`);
  },
  runningHeadless: (proj) => {
    // A headless run is "alive" only if BOTH:
    //   (a) it is within its wall-clock ceiling, AND
    //   (b) its task (if any) is still in a live state — a run whose task was
    //       requeued/expired/accepted is a GHOST whose worker.exited was lost.
    // Also, a run with no task that has been "running" for >25min without ever
    // leasing anything is a ghost too (workers claim within seconds).
    const ceilingMs = (proj.state.workers.maxRunMinutes ?? Math.min(proj.state.budgets.limits.wallClockMinutes, 720)) * 60_000 + 120_000;
    const now = Date.now();
    const liveTask = new Set<string>();
    for (const t of proj.tasks.values()) {
      if (t.status === "leased" || t.status === "running") liveTask.add(t.id);
    }
    let alive = 0;
    for (const r of proj.agentRuns.values()) {
      if (r.mode !== "headless" || r.status !== "running" || !r.startedAt) continue;
      if (now - Date.parse(r.startedAt) > ceilingMs) continue;
      if (r.taskId && liveTask.has(r.taskId)) { alive++; continue; }
      if (!r.taskId && now - Date.parse(r.startedAt) < 25 * 60_000) { alive++; continue; } // fresh idle worker (claims within seconds)
      // ghost: mark it dead so projections stay honest AND autoSpawn unblocks
      core.apply(proj, "worker.exited", { kind: "system", id: "researchd" }, {
        runId: r.id, status: "failed", summary: "ghost run detected (no live task; worker.exited lost)",
      }, { correlationId: r.id });
    }
    return alive;
  },
});

// ---- HTTP
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/v1/stream") {
    sseStream(core, url.searchParams.get("campaign"), res);
    return;
  }
  void handleRequest({ core, modulesDir: MODULES_DIR, piPackageDir: PI_PACKAGE_DIR, mesh, jobs: jobRunner, schedulerHealth: heartbeat }, req, res).catch((err) => {
    process.stderr.write(`[researchd] request error: ${String(err)}\n`);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
});

let timer: NodeJS.Timeout | undefined;
// scheduler heartbeat — lets the queue watchdog distinguish a dead scheduler from an idle queue
let lastTickMs = 0;
let tickCount = 0;
let tickErrors = 0;
const heartbeat = (): { lastTickMs: number; tickCount: number; tickErrors: number } => ({ lastTickMs, tickCount, tickErrors });
server.on("error", (err) => {
  // port taken (stale daemon): fail fast — never tick or spawn workers unbound
  process.stderr.write(`[researchd] FATAL: cannot bind — ${String(err)}\n`);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(`[researchd] listening on http://127.0.0.1:${PORT}\n`);
  // scheduler only starts once the port is actually ours
  timer = setInterval(() => {
    try {
      scheduler.tick();
      tickCount += 1;
      lastTickMs = Date.now();
    } catch (err) {
      tickErrors += 1;
      lastTickMs = Date.now();
      process.stderr.write(`[researchd] scheduler tick threw: ${String(err)}\n`);
    }
  }, TICK_MS);
  timer.unref?.();
});

// join mesh rooms for new campaigns
core.subscribe((campaignId) => {
  if (campaignId) mesh.joinRoom(campaignRoom(campaignId));
});

// ---- V0.4: workspace-global cross-campaign memory (mirror + inject)
const globalPaths = globalStorePaths(HOME);
const globalMemorySeen = new Set<string>();
const globalSkillState = new Map<string, GlobalSkillEntry>();
function refreshGlobalSources(): void {
  setGlobalContextSources({
    lessons: loadMemoryStore(globalPaths.memory),
    skills: [...globalSkillState.values()],
  });
}
refreshGlobalSources();
core.subscribe((campaignId, event) => {
  void campaignId;
  try {
    if (event.type === "memory.episode_created") {
      const m = event.payload.memory as { kind?: string; title?: string; content?: Record<string, unknown> };
      if (m?.kind === "negative" && m.title) {
        const hash = memoryHash(m as never);
        if (!globalMemorySeen.has(hash)) {
          globalMemorySeen.add(hash);
          const entry: GlobalMemoryEntry = { hash, campaignId: event.campaignId, kind: "negative", title: m.title, content: m.content ?? {}, createdAt: event.timestamp };
          appendFileSync(globalPaths.memory, JSON.stringify(entry) + "\n", "utf8");
          // cap: keep the 500 most recent entries (simple LRU-by-time)
          const all = loadMemoryStore(globalPaths.memory);
          if (all.length > 500) {
            const { writeFileSync } = require("node:fs") as typeof import("node:fs");
            writeFileSync(globalPaths.memory, all.slice(-500).map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
          }
          refreshGlobalSources();
        }
      }
    }
    if (event.type === "memory.skill_candidate_created") {
      const s = event.payload.skill as { id?: string; name?: string; activation?: string[]; procedure?: string[] };
      if (s?.name) {
        globalSkillState.set(s.name, { id: s.id ?? s.name, hash: s.name, campaignId: event.campaignId, name: s.name, activation: s.activation ?? [], procedure: s.procedure ?? [], state: "candidate", citations: 0, createdAt: event.timestamp });
        appendFileSync(globalPaths.skills, JSON.stringify(globalSkillState.get(s.name)) + "\n", "utf8");
        refreshGlobalSources();
      }
    }
    if (event.type === "memory.skill_cited" || event.type === "memory.skill_activated") {
      const proj = core.getCampaign(event.campaignId);
      const sk = proj?.skills.get(String(event.payload.skillId));
      if (sk) {
        const prev = globalSkillState.get(sk.name);
        globalSkillState.set(sk.name, {
          id: sk.id, hash: sk.name, campaignId: event.campaignId, name: sk.name,
          activation: sk.activation, procedure: sk.procedure,
          state: sk.verificationState === "active" ? "active" : "candidate",
          citations: Math.max(prev?.citations ?? 0, sk.citations ?? 0), createdAt: prev?.createdAt ?? event.timestamp,
        });
        refreshGlobalSources();
      }
    }
  } catch {
    /* global mirror is best-effort */
  }
});

function shutdown(): void {
  process.stderr.write("[researchd] shutting down\n");
  if (timer) clearInterval(timer);
  void mesh.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref?.();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
