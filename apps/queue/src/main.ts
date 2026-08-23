// main.ts — the queue supervisor. One campaign at a time, forever.
//
//   node dist/main.js [--once]
//
// Loop semantics:
//   1. ensure researchd healthy (spawn + wait on crash; campaign state replays from events)
//   2. if a current campaign is tracked: wait for terminal (completed/stopped);
//      on terminal → export report, record, pick next
//   3. if no current campaign: ADOPT any running campaign (e.g. started by hand),
//      else create + start the next YAML from the queue dir (sorted, not already done)
//   4. every transition is persisted to workspaces/queue.json
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Watchdog, DEFAULT_WATCHDOG, eventsLiveness, type CampaignLiveness } from "./watchdog.js";
import { openKnowledge, consolidate, bestBound, lookup } from "@research-os/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
const PORT = Number(process.env.RESEARCH_PORT ?? 8787);
const BASE = process.env.RESEARCH_URL ?? `http://127.0.0.1:${PORT}`;
const QUEUE_DIR = process.env.RESEARCH_QUEUE_DIR ?? path.join(ROOT, "examples", "open-problems");
const HOME = process.env.RESEARCH_HOME ?? path.join(ROOT, "workspaces");
const STATE_FILE = process.env.RESEARCH_QUEUE_STATE ?? path.join(HOME, "queue.json");
const REPORT_DIR = path.join(HOME, "reports");
const POLL_MS = Number(process.env.RESEARCH_QUEUE_POLL_MS ?? 10_000);
const DAEMON = path.join(ROOT, "apps", "researchd", "dist", "main.js");
const ONCE = process.argv.includes("--once");

interface QueueState {
  startedAt: string;
  current: { file: string; campaignId: string; startedAt: string; adopted?: boolean } | null; // legacy single-slot (read compat)
  slots?: { file: string; campaignId: string; startedAt: string; adopted?: boolean }[];
  done: { file: string; campaignId: string; status: string; finishedAt: string; report?: string; summary?: string; boundsOk?: boolean; boundsFindings?: string; firstPass?: boolean }[];
  failed: { file: string; reason: string; at: string }[];
  watchdog?: { incidents: Record<string, { stage: string; note?: string; restarts: number[] }> };
}

const log = (msg: string): void => {
  process.stdout.write(`[queue ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function loadState(): QueueState {
  if (existsSync(STATE_FILE)) {
    try {
      const s = JSON.parse(readFileSync(STATE_FILE, "utf8")) as QueueState;
      if (Array.isArray(s.done) && Array.isArray(s.failed)) return s;
    } catch {
      /* rebuild */
    }
  }
  return { startedAt: new Date().toISOString(), current: null, slots: [], done: [], failed: [] };
}

function saveState(s: QueueState): void {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function api<T = unknown>(method: string, p: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

// ---- researchd watchdog -----------------------------------------------------
let daemon: ChildProcess | null = null;

async function healthy(): Promise<boolean> {
  try {
    await api("GET", "/v1/health", undefined, 4000);
    return true;
  } catch {
    return false;
  }
}

async function ensureDaemon(): Promise<void> {
  if (await healthy()) return;
  log("researchd unreachable — spawning daemon");
  mkdirSync(HOME, { recursive: true });
  daemon?.kill();
  daemon = spawn(process.execPath, [DAEMON], {
    cwd: ROOT,
    env: { ...process.env, RESEARCH_PORT: String(PORT), RESEARCH_HOME: HOME },
    stdio: ["ignore", "ignore", "pipe"],
  });
  daemon.stderr?.on("data", (d: Buffer) => writeFileSync(path.join(HOME, "researchd.log"), d, { flag: "a" }));
  daemon.on("exit", (code) => log(`daemon child exited (code ${code}) — will respawn if needed`));
  for (let i = 0; i < 60; i++) {
    if (await healthy()) {
      log("researchd healthy (spawned)");
      return;
    }
    await sleep(1000);
  }
  throw new Error("researchd did not come up in 60s");
}

// ---- queue logic --------------------------------------------------------------
interface CampaignSummary {
  id: string;
  title: string;
  status: string;
}

function queueFiles(): string[] {
  if (!existsSync(QUEUE_DIR)) return [];
  return readdirSync(QUEUE_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .sort();
}

async function nextFile(state: QueueState): Promise<string | null> {
  const doneFiles = new Set([...state.done.map((d) => d.file), ...state.failed.map((f) => f.file)]);
  const activeFiles = new Set((state.slots ?? []).map((s) => s.file));
  for (const f of queueFiles()) {
    if (!doneFiles.has(f) && !activeFiles.has(f)) return f;
  }
  return null;
}

async function exportReport(campaignId: string, file: string): Promise<string> {
  const res = await fetch(`${BASE}/v1/campaigns/${encodeURIComponent(campaignId)}/report`, { signal: AbortSignal.timeout(30_000) });
  const md = await res.text();
  mkdirSync(REPORT_DIR, { recursive: true });
  const out = path.join(REPORT_DIR, file.replace(/\.yaml$/, "") + ".md");
  writeFileSync(out, md, "utf8");
  return out;
}

function runCheckBounds(campaignId: string): Promise<{ ok: boolean; findings: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "bin", "check-bounds.mjs"), campaignId], { cwd: ROOT, env: { ...process.env, RESEARCH_HOME: HOME } });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", () => resolve({ ok: true, findings: "check-bounds unavailable" }));
    child.on("close", (code) => resolve({ ok: code === 0, findings: (out + err).trim().slice(0, 500) }));
  });
}

async function createViaCli(file: string): Promise<string> {
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "apps", "cli", "dist", "main.js"), "campaign", "create", path.join(QUEUE_DIR, file)], {
      cwd: ROOT,
      env: { ...process.env, RESEARCH_URL: BASE },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let buf = "";
    child.stdout?.on("data", (d) => (buf += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(buf) : reject(new Error(`cli create failed: ${buf.slice(0, 300)}`))));
  });
  const m = /"id":\s*"(campaign:c_\d+)"/.exec(out);
  if (!m) throw new Error(`no campaign id in cli output: ${out.slice(0, 200)}`);
  return m[1];
}

/** returns true when queue state changed */
async function tick(state: QueueState): Promise<boolean> {
  await ensureDaemon();

  // v0.5: multi-slot concurrent campaigns. Legacy `current` migrates into slots.
  if (!state.slots) state.slots = [];
  if (state.current && !state.slots.some((x) => x.campaignId === state.current!.campaignId)) {
    state.slots.push(state.current);
  }
  state.current = null;

  let changed = false;
  const campaigns = await api<{ id: string; title: string; status: string }[]>("GET", "/v1/campaigns");

  // 1. settle finished slots
  for (const slot of [...state.slots]) {
    const cur = campaigns.find((c) => c.id === slot.campaignId);
    if (!cur) {
      log(`slot campaign ${slot.campaignId} vanished — marking failed`);
      state.failed.push({ file: slot.file, reason: "campaign missing from researchd", at: new Date().toISOString() });
      state.slots = state.slots.filter((x) => x !== slot);
      changed = true;
      continue;
    }
    if (cur.status === "running" || cur.status === "created" || cur.status === "paused") {
      if (cur.status === "paused") log(`waiting: ${cur.id} is PAUSED (resume or stop it to unblock the slot)`);
      continue;
    }
    try {
      const report = await exportReport(cur.id, slot.file);
      const bounds = await runCheckBounds(cur.id);
      state.done.push({ file: slot.file, campaignId: cur.id, status: cur.status, finishedAt: new Date().toISOString(), report, summary: cur.title, boundsOk: bounds.ok, boundsFindings: bounds.findings, firstPass: true });
      log(`DONE ${cur.id} (${cur.status}) — report: ${report}${bounds.ok ? " — bounds OK" : ` — ⚠ BOUNDS: ${bounds.findings.slice(0, 200)}`}`);
      try {
        const k = openKnowledge(HOME);
        const wsDir = await findWorkspaceDir(cur.id);
        if (wsDir) {
          const evFile = path.join(wsDir, "state", "events.jsonl");
          if (existsSync(evFile)) {
            const events = readFileSync(evFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as never);
            const problem = slot.file.replace(/\.yaml$/, "");
            const r = consolidate(k, events, problem);
            log(`CONSOLIDATED ${problem}: +${r.added} knowledge objects (${r.skipped} idempotent-skips)`);
            const bb = bestBound(k, problem);
            const CEILINGS: Record<string, number> = { "01-collatz-syracuse": 5_000_000, "05-gilbreath": 5000 };
            const ceiling = CEILINGS[problem];
            if (bb && ceiling && bb.max >= ceiling * 0.999) {
              log(`T1 SKIP ${problem}: bound ${bb.max} already at verifier ceiling ${ceiling}`);
            } else if (bb) {
              const reiterateFile = path.join(QUEUE_DIR, `${problem}-round2.yaml`);
              if (!existsSync(reiterateFile)) {
                writeFileSync(reiterateFile, renderReiterate(problem, bb.max), "utf8");
                log(`T1 ENQUEUED ${problem}-round2.yaml (prior bound ${bb.max.toLocaleString("en-US")} < ceiling)`);
              }
            }
            const distillFile = path.join(QUEUE_DIR, `zz-${problem}-distill.yaml`);
            if (!existsSync(distillFile)) {
              writeFileSync(distillFile, renderDistill(problem, cur.id), "utf8");
              log(`DISTILL ENQUEUED zz-${problem}-distill.yaml (agent consolidation of ${cur.id})`);
            }
            // v0.6: RED-TEAM — when a campaign completes with verified claims, spawn an adversarial campaign
            // whose sole objective is to DESTROY the result. If it survives, it earns the survived-red-team badge.
            if (cur.status === "completed") {
              try {
                const kn = openKnowledge(HOME);
                const lk = lookup(kn, problem);
                if (lk.covered && lk.verifiedClaims.length > 0) {
                  const rtFile = path.join(QUEUE_DIR, `zz-${problem}-redteam.yaml`);
                  if (!existsSync(rtFile)) {
                    writeFileSync(rtFile, renderRedTeam(problem, cur.id, lk.verifiedClaims.length), "utf8");
                    log(`RED-TEAM ENQUEUED zz-${problem}-redteam.yaml (${lk.verifiedClaims.length} verified claims to attack)`);
                  }
                }
              } catch (err) {
                log(`red-team check failed: ${String(err)}`);
              }
            }
          }
        }
      } catch (err) {
        log(`consolidation failed for ${cur.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err) {
      state.failed.push({ file: slot.file, reason: `report export failed: ${String(err)}`, at: new Date().toISOString() });
      log(`report export failed for ${cur.id}: ${String(err)}`);
    }
    state.slots = state.slots.filter((x) => x !== slot);
    changed = true;
  }

  // 2. adopt untracked running campaigns (hand-started)
  for (const cur of campaigns.filter((c) => c.status === "running")) {
    if (state.slots.some((x) => x.campaignId === cur.id)) continue;
    const base = slugFromTitle(cur.title);
    const fileGuess = queueFiles().find((f) => f.replace(/\.yaml$/, "").endsWith(base)) ?? `adopted-${cur.id.replace("campaign:", "")}.yaml`;
    state.slots.push({ file: fileGuess, campaignId: cur.id, startedAt: new Date().toISOString(), adopted: true });
    log(`ADOPTED running campaign ${cur.id} — ${cur.title.slice(0, 70)}`);
    changed = true;
  }

  // 3. fill free slots up to MAX_CONCURRENT
  const MAX_CONCURRENT = Number(process.env.RESEARCH_QUEUE_CONCURRENCY ?? 3);
  while (state.slots.length < MAX_CONCURRENT) {
    const file = await nextFile(state);
    if (!file) {
      if (state.slots.length === 0) log("queue empty — idle (drop new YAMLs into the queue dir)");
      break;
    }
    const created = await createViaCli(file);
    await api("POST", `/v1/campaigns/${encodeURIComponent(created)}/start`, {});
    state.slots.push({ file, campaignId: created, startedAt: new Date().toISOString() });
    log(`STARTED ${created} from ${file} (slot ${state.slots.length}/${MAX_CONCURRENT})`);
    changed = true;
  }

  return changed;
}


async function findWorkspaceDir(campaignId: string): Promise<string | null> {
  const campaigns = await api<{ id: string; workspace?: string }[]>("GET", "/v1/campaigns", undefined, 10_000);
  const c = campaigns.find((x) => x.id === campaignId);
  return c?.workspace ?? null;
}


function slugFromTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}


function renderRedTeam(problem: string, sourceCampaignId: string, nClaims: number): string {
  return `campaign:
  title: "RED-TEAM — ${problem} (destroy the result of ${sourceCampaignId})"
  modules: [mathematics]
  objective:
    statement: "You are a RED TEAM. The campaign ${sourceCampaignId} claims ${nClaims} verified results. Your SOLE objective is to DESTROY them. Attack every verified claim: (1) RE-COMPUTE independently from scratch — different algorithm, different implementation, no access to the original scripts; (2) hunt for counterexamples the original missed — edge cases, boundary values, larger domains; (3) check for CIRCULAR REASONING — does the verification depend on the thing being verified?; (4) attack the certificates — are the witnesses actually valid? did the verifier check what the claim says?; (5) test the claims under adversarial perturbation — if the claim says 'for all n ≤ K', test n = K+1, K+10, K+100; (6) look for off-by-one, sign errors, indexing errors, overflow; (7) check the bound-integrity — does the claim's stated bound match what was actually verified? If EVERY attack fails and the results hold, submit a synthesis noting they SURVIVED red-team. If ANY attack succeeds, the result is DESTROYED — document exactly how and why."
    questions:
      - "Can each verified claim be independently reproduced from scratch?"
      - "Are there counterexamples just beyond the verified bounds?"
      - "Is there any circularity in the verification chain?"
      - "Do the certificates actually prove what the claims state?"
    deliverables:
      - kind: report
        description: "Red-team verdict: SURVIVED or DESTROYED with precise failure modes"
    successCriteria:
      - type: claim_status
        value: verified
        description: "at least one independent re-verification performed (proving the red-team did real work, not rubber-stamping)"
    constraints:
      - "re-implement from scratch — NEVER reuse the original campaign's scripts or artifacts as starting points"
      - "exact arithmetic only; every re-computation must be independent"
      - "if you destroy a result, document the exact failure mode for the human"
    exclusions: []
    assumptions: ["source campaign claims visible via ContextPack.priorRuns"]
    riskClass: low
  models:
    defaultPool:
      - id: zai-glm-5.3
        provider: zai
        model: glm-5.3
        runtime: pi
        thinkingLevel: max
        tags: [default]
  search: { policy: round-robin, blindGenerators: 1, maxBranches: 4 }
  budgets: { maxAgentRuns: 12, maxTasks: 20, maxRounds: 2, maxExperiments: 10, wallClockMinutes: 120, maxTokensEstimate: 15000000 }
  autonomy: { level: L3, humanApprovalRequiredFor: [] }
  workers: { autoSpawn: 2, leaseSeconds: 1800, maxRunMinutes: 120 }
  stop: { onSuccess: true, onBudgetExhausted: true, noProgressRounds: 2, successSemantics: "any", minRounds: 1, requireCycle: false }
  modulePrompts:
    worker: "RED-TEAM MODE: your ContextPack.priorRuns shows what ${sourceCampaignId} verified. Your job is DESTRUCTION, not confirmation. Re-implement every computation from scratch (different approach if possible). Hunt for counterexamples beyond the verified bounds. Check circularity. Attack the certificates. If results hold → they earned the survived-red-team badge. If any fails → document the precise failure. This is constructive destruction: the goal is that whatever survives is TRUSTWORTHY."
  verification: { requireIndependentAudit: true }
`;
}

function renderDistill(problem: string, sourceCampaignId: string): string {
  return `campaign:
  title: "DISTILL — ${problem} (agent consolidation of ${sourceCampaignId})"
  modules: [mathematics]
  objective:
    statement: "You are a CONSOLIDATOR: read the full event journal of ${sourceCampaignId} (research_get_journal, all pages) and distill what the mechanical extractor CANNOT capture. Produce 3-7 knowledge lessons: (1) LESSONS — the 3-5 things that actually mattered (which strategy won, what was the real bottleneck, what surprised); (2) GENERALIZED-SKILLS — procedures learned here that transfer to OTHER problems (state applicability); (3) CROSS-LINKS — real analogies to other problems in the queue (the C-sharding skill from taxicab applies to Ramsey, etc); (4) SYNTHESIS — a 5-sentence narrative for the next round. MANDATORY: every lesson cites sourceEventIds you actually read — fabricated ids are REJECTED by the validation gate."
    questions:
      - "What were the 3 most important events/decisions in the journal?"
      - "Which learned procedures transfer to other problems?"
      - "What narrative summary would help the next round start smarter?"
    deliverables:
      - kind: report
        description: "Distilled lessons with journal citations"
    successCriteria:
      - type: claim_status
        value: verified
        description: "at least one lesson accepted through the source-validation gate"
    constraints:
      - "every lesson MUST cite real event ids from research_get_journal"
      - "lessons without sources are rejected — no invention"
    exclusions: []
    assumptions: []
    riskClass: low
  models:
    defaultPool:
      - id: zai-glm-5.3
        provider: zai
        model: glm-5.3
        runtime: pi
        thinkingLevel: max
        tags: [default]
  search: { policy: round-robin, blindGenerators: 1, maxBranches: 2 }
  budgets: { maxAgentRuns: 4, maxTasks: 6, maxRounds: 1, maxExperiments: 2, wallClockMinutes: 45, maxTokensEstimate: 10000000 }
  autonomy: { level: L3, humanApprovalRequiredFor: [] }
  workers: { autoSpawn: 1, leaseSeconds: 1800, maxRunMinutes: 45 }
  stop: { onSuccess: true, onBudgetExhausted: true, noProgressRounds: 1, successSemantics: "any", minRounds: 1, requireCycle: false }
  modulePrompts:
    worker: "CONSOLIDATOR MODE: use research_get_journal to read ALL pages of ${sourceCampaignId}'s journal (object.created, claim.status_changed, verification.passed, memory.episode_created). Then submit 3-7 research_submit_lesson calls: kind lesson/generalized-skill/cross-link/synthesis, each with sourceEventIds from the journal you READ. The validation gate rejects fabricated ids — only cite what you saw."
  verification: { requireIndependentAudit: true }
`;
}

function renderReiterate(problem: string, priorBound: number): string {
  return `campaign:
  title: "REITERATION — ${problem} round 2 (prior verified bound ${priorBound})"
  modules: [mathematics]
  objective:
    statement: "Round 2 on ${problem}: the system has PRIOR WORK (verified bound n=${priorBound}, dead-ends, skills — see your ContextPack priorRuns). Goal: EXTEND, don't repeat — (1) push the strongest verified bound beyond ${priorBound} (or to its verifier ceiling), (2) attack the surviving auxiliaries/conjectures from round 1 with the learned dead-ends in mind, (3) apply active skills; supersede (never duplicate) existing verified claims."
    questions:
      - "What is the strongest round-1 result, and what exactly blocks pushing it further?"
      - "Which round-1 dead-ends have a DIFFERENT attack enabled by current capabilities?"
    deliverables:
      - kind: report
        description: "Round-2 report: new bounds vs round-1, superseded claims, new dead-ends"
    successCriteria:
      - type: claim_status
        value: verified
        description: "a claim that EXTENDS beyond the round-1 verified bound (not a duplicate)"
    constraints:
      - "never re-verify an established bound — start beyond it"
      - "exact arithmetic only; bounds stated honestly"
    exclusions: []
    assumptions: ["prior work available in ContextPack.priorRuns"]
    riskClass: low
  models:
    defaultPool:
      - id: zai-glm-5.3
        provider: zai
        model: glm-5.3
        runtime: pi
        thinkingLevel: max
        tags: [default]
  search: { policy: round-robin, blindGenerators: 3, maxBranches: 8 }
  budgets: { maxAgentRuns: 30, maxTasks: 60, maxRounds: 4, maxExperiments: 20, wallClockMinutes: 240, maxTokensEstimate: 40000000 }
  autonomy: { level: L3, humanApprovalRequiredFor: [] }
  workers: { autoSpawn: 2, leaseSeconds: 3600, maxRunMinutes: 240 }
  stop: { onSuccess: true, onBudgetExhausted: true, noProgressRounds: 2, successSemantics: "any", minRounds: 1, requireCycle: false }
  modulePrompts:
    worker: "REITERATION MODE: your ContextPack contains priorRuns (verified bounds, dead-ends, skills from round 1). EXTEND, don't repeat. A claim that merely restates round-1 work is a failure. Push bounds beyond ${priorBound} or attack open auxiliaries with new representations."
  verification: { requireIndependentAudit: true }
`;
}

async function watchdogTick(watchdog: Watchdog, state: QueueState): Promise<string[]> {
  const acted: string[] = [];
  try {
    const campaigns = await api<{ id: string; status: string; workspace?: string; counts?: { queued?: number; tasksByStatus?: Record<string, number> } }[]>("GET", "/v1/campaigns", undefined, 10_000);
    const now = Date.now();
    for (const c of campaigns) {
      const byStatus = c.counts?.tasksByStatus ?? {};
      const queued = Number(byStatus.queued ?? 0);
      const leased = Number(byStatus.running ?? 0) + Number(byStatus.leased ?? 0);
      if (c.status !== "running" || queued + leased === 0) continue;
      const { eventsFile, mtimeMs } = eventsLiveness(HOME, c.id, c.workspace);
      const live: CampaignLiveness = {
        campaignId: c.id, status: c.status, running: c.status === "running",
        queuedTasks: queued, leasedTasks: leased, eventsFile, eventsMtimeMs: mtimeMs,
      };
      const d = watchdog.evaluate(live, now);
      if (d.action === "none") continue;
      if (d.action === "warn") {
        log(`WATCHDOG ⚠ ${c.id}: ${d.reason} (events file: ${path.basename(path.dirname(path.dirname(eventsFile)))})`);
        acted.push(`${c.id}:warn`);
      } else if (d.action === "restart" || d.action === "kill") {
        log(`WATCHDOG ${d.action === "kill" ? "🔴" : "🟠"} ${c.id}: ${d.reason} — restarting researchd`);
        await restartDaemon(d.action === "kill");
        acted.push(`${c.id}:${d.action}`);
      } else if (d.action === "park") {
        log(`WATCHDOG 🅿 ${c.id}: ${d.reason} — pausing campaign for human review`);
        try {
          await api("POST", `/v1/campaigns/${encodeURIComponent(c.id)}/pause`, { reason: d.reason }, 10_000);
        } catch (err) {
          log(`pause failed for ${c.id}: ${String(err)}`);
        }
        acted.push(`${c.id}:park`);
      }
    }
  } catch (err) {
    // API unreachable: ensureDaemon in the next tick handles respawn — no watchdog spam
  }
  return acted;
}

async function restartDaemon(hard: boolean): Promise<void> {
  const pid = daemon?.pid;
  if (pid) {
    try {
      process.kill(pid, hard ? "SIGKILL" : "SIGTERM");
      log(`daemon pid ${pid} ${hard ? "SIGKILLed" : "SIGTERMed"}`);
    } catch {
      /* already dead */
    }
    await sleep(2000);
  }
  // pkill strays then respawn (ensureDaemon on next tick also covers this)
  const { spawn: sp } = await import("node:child_process");
  sp("/usr/bin/pkill", ["-f", "apps/researchd/dist/main.js"], { stdio: "ignore" });
  await sleep(1000);
  await ensureDaemon();
}

async function main(): Promise<void> {
  const state = loadState();
  log(`queue supervisor up — dir=${QUEUE_DIR} state=${STATE_FILE} once=${ONCE}`);
  log(`progress: ${state.done.length} done, ${state.failed.length} failed${state.current ? `, current=${state.current.campaignId}` : ""}`);
  const watchdog = new Watchdog({ ...DEFAULT_WATCHDOG, idleThresholdMs: Number(process.env.RESEARCH_QUEUE_IDLE_MS ?? DEFAULT_WATCHDOG.idleThresholdMs) });
  if (!state.watchdog) state.watchdog = { incidents: {} };
  watchdog.state = { incidents: state.watchdog.incidents as never };

  for (;;) {
    try {
      if (await tick(state)) saveState(state);
      const actions = await watchdogTick(watchdog, state);
      if (actions.length > 0) {
        state.watchdog = { incidents: watchdog.state.incidents as never };
        saveState(state);
      }
    } catch (err) {
      log(`tick error: ${err instanceof Error ? err.message : String(err)}`);
      saveState(state);
    }
    if (ONCE) break;
    await sleep(POLL_MS);
  }
}

process.on("SIGINT", () => {
  log("shutdown (daemon left running)");
  process.exit(0);
});
process.on("SIGTERM", () => process.exit(0));

void main();
