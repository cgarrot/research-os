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
  current: { file: string; campaignId: string; startedAt: string; adopted?: boolean } | null;
  done: { file: string; campaignId: string; status: string; finishedAt: string; report?: string; summary?: string; boundsOk?: boolean; boundsFindings?: string }[];
  failed: { file: string; reason: string; at: string }[];
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
  return { startedAt: new Date().toISOString(), current: null, done: [], failed: [] };
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
  for (const f of queueFiles()) {
    if (!doneFiles.has(f)) return f;
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

  // 1. current campaign: wait or settle
  if (state.current) {
    const campaigns = await api<CampaignSummary[]>("GET", "/v1/campaigns");
    const cur = campaigns.find((c) => c.id === state.current!.campaignId);
    if (!cur) {
      log(`current campaign ${state.current.campaignId} vanished — marking failed`);
      state.failed.push({ file: state.current.file, reason: "campaign missing from researchd", at: new Date().toISOString() });
      state.current = null;
      return true;
    }
    if (cur.status === "running" || cur.status === "created" || cur.status === "paused") {
      if (cur.status === "paused") log(`waiting: ${cur.id} is PAUSED (resume or stop it to unblock the queue)`);
      return false;
    }
    try {
      const report = await exportReport(cur.id, state.current.file);
      // V0.4.4: attach the bounds integrity check to the done entry
      const bounds = await runCheckBounds(cur.id);
      state.done.push({ file: state.current.file, campaignId: cur.id, status: cur.status, finishedAt: new Date().toISOString(), report, summary: cur.title, boundsOk: bounds.ok, boundsFindings: bounds.findings });
      log(`DONE ${cur.id} (${cur.status}) — report: ${report}${bounds.ok ? " — bounds OK" : ` — ⚠ BOUNDS: ${bounds.findings.slice(0, 200)}`}`);
    } catch (err) {
      state.failed.push({ file: state.current.file, reason: `report export failed: ${String(err)}`, at: new Date().toISOString() });
      log(`report export failed for ${cur.id}: ${String(err)}`);
    }
    state.current = null;
    return true;
  }

  // 2. adopt any running campaign (started by hand)
  const campaigns = await api<CampaignSummary[]>("GET", "/v1/campaigns");
  const running = campaigns.filter((c) => c.status === "running");
  if (running.length > 0) {
    const cur = running[0];
    const base = slugFromTitle(cur.title);
    const fileGuess = queueFiles().find((f) => f.replace(/\.yaml$/, "").endsWith(base)) ?? `adopted-${cur.id.replace("campaign:", "")}.yaml`;
    state.current = { file: fileGuess, campaignId: cur.id, startedAt: new Date().toISOString(), adopted: true };
    log(`ADOPTED running campaign ${cur.id} — ${cur.title.slice(0, 70)}`);
    return true;
  }

  // 3. start the next queue file
  const file = await nextFile(state);
  if (!file) {
    log("queue empty — idle (drop new YAMLs into the queue dir; they get picked up)");
    return false;
  }
  const created = await createViaCli(file);
  await api("POST", `/v1/campaigns/${encodeURIComponent(created)}/start`, {});
  state.current = { file, campaignId: created, startedAt: new Date().toISOString() };
  log(`STARTED ${created} from ${file}`);
  return true;
}

function slugFromTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

async function main(): Promise<void> {
  const state = loadState();
  log(`queue supervisor up — dir=${QUEUE_DIR} state=${STATE_FILE} once=${ONCE}`);
  log(`progress: ${state.done.length} done, ${state.failed.length} failed${state.current ? `, current=${state.current.campaignId}` : ""}`);
  for (;;) {
    try {
      if (await tick(state)) saveState(state);
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
