// novelty.test.ts — the novelty layer engine tests (spec §22 fixtures, §5.5,
// §18.1, §8.6): frontier resolution/staleness/improvement, novelty status rules,
// promotion gates, durable job lifecycle.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import http from "node:http";
import {
  ResearchCore,
  Scheduler,
  loadModules,
  verifiersForCampaign,
  resolveFrontier,
  isStale,
  improvesFrontier,
  deriveNoveltyStatus,
  promotionCheck,
} from "@research-os/core";
import { handleRequest } from "../server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("repo root not found");
}
const ROOT = findRepoRoot(__dirname);

// ---- spec §22 fixtures (pure logic) ----

test("fixture 1: A=100, B=100 (same class) -> agree", () => {
  const r = resolveFrontier([
    { sourceType: "curated", value: "100", date: "2024-01-01" },
    { sourceType: "curated", value: "100", date: "2023-06-01" },
  ]);
  assert.equal(r.sourceAgreement, "agree");
  assert.equal(r.value, "100");
});

test("fixture 2: newer PRIMARY 101 beats curated 100 -> 101 with provenance", () => {
  const r = resolveFrontier([
    { sourceType: "secondary", value: "102", date: "2020-01-01" },
    { sourceType: "curated", value: "100", date: "2024-01-01" },
    { sourceType: "primary", value: "101", date: "2025-06-01" },
  ]);
  assert.equal(r.value, "101");
  assert.equal(r.confidence, "primary");
  assert.equal(r.sourceAgreement, "partial"); // the 102 secondary disagrees
});

test("fixture 3: secondary 102 vs primary 101 (same-class conflict would block; lower class does not win)", () => {
  const r = resolveFrontier([
    { sourceType: "primary", value: "101", date: "2025-01-01" },
    { sourceType: "primary", value: "103", date: "2025-02-01" },
  ]);
  assert.equal(r.sourceAgreement, "conflict", "same-class disagreement flags conflict — no silent pick");
});

test("fixture 4: candidate beats cached 100 but live refresh says 103 -> NOT a record", () => {
  const staleSnapshot = { currentValue: "100", frontierType: "lower-bound" as const, comparison: ">" as const };
  const liveSnapshot = { currentValue: "103", frontierType: "lower-bound" as const, comparison: ">" as const };
  assert.ok(improvesFrontier("102", staleSnapshot), "beats the stale cache…");
  assert.ok(!improvesFrontier("102", liveSnapshot), "…but NOT the refreshed frontier");
});

test("fixture 5 logic: record promotion refuses stale frontier (gate)", () => {
  const cand = {
    candidateType: "record" as const,
    statement: "coloring of length 3704",
    correctnessStatus: "exactly-verified" as const,
    noveltyStatus: "likely-new-after-audited-search" as never,
    promotionStatus: "quarantined" as never,
    frontierSnapshotId: "frontier_snapshot:f_1",
    improvesFrontier: true,
  };
  const gate = promotionCheck(cand, false /* stale */);
  assert.equal(gate.ok, false);
  assert.ok(gate.reasons.some((r) => r.includes("stale")));
  const fresh = promotionCheck(cand, true);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.promotionStatus, "human-review", "terminal state is always human review");
});

test("staleness: records stale after 24h, classifications after 90d", () => {
  const now = Date.now();
  assert.ok(isStale({ capturedAt: new Date(now - 25 * 3600e3).toISOString(), frontierType: "record" }, now));
  assert.ok(!isStale({ capturedAt: new Date(now - 23 * 3600e3).toISOString(), frontierType: "record" }, now));
  assert.ok(!isStale({ capturedAt: new Date(now - 30 * 86400e3).toISOString(), frontierType: "classification" }, now));
});

// ---- novelty status machine (spec §5.5) ----

test("quick mode NEVER yields likely-new; insufficient coverage is not-found", () => {
  const quick = deriveNoveltyStatus({ mode: "quick", providers: ["oeis", "web"], subjectKind: "statement", exactMatchQueries: 3, definitionQueries: 0, structuralQueries: 0, recentWindowSearched: false, probableMatches: 0, providerErrors: 0 }, false);
  assert.notEqual(quick.status, "likely-new-after-audited-search");
  const thin = deriveNoveltyStatus({ mode: "standard", providers: ["oeis"], subjectKind: "statement", exactMatchQueries: 1, definitionQueries: 0, structuralQueries: 0, recentWindowSearched: false, probableMatches: 0, providerErrors: 0 }, false);
  assert.equal(thin.status, "not-found");
  assert.ok(thin.missing.length > 0, "coverage gaps recorded");
});

test("full standard audit on a sequence reaches likely-new ONLY with OEIS + coverage", () => {
  const good = deriveNoveltyStatus({ mode: "standard", providers: ["oeis", "openalex", "web"], subjectKind: "sequence", exactMatchQueries: 3, definitionQueries: 2, structuralQueries: 0, recentWindowSearched: true, probableMatches: 0, providerErrors: 0 }, false);
  assert.equal(good.status, "likely-new-after-audited-search");
  const noOeis = deriveNoveltyStatus({ mode: "standard", providers: ["openalex", "arxiv", "web"], subjectKind: "sequence", exactMatchQueries: 3, definitionQueries: 2, structuralQueries: 0, recentWindowSearched: true, probableMatches: 0, providerErrors: 0 }, false);
  assert.notEqual(noOeis.status, "likely-new-after-audited-search");
  const outage = deriveNoveltyStatus({ mode: "deep", providers: ["oeis", "web"], subjectKind: "statement", exactMatchQueries: 3, definitionQueries: 2, structuralQueries: 1, recentWindowSearched: true, probableMatches: 0, providerErrors: 2 }, false);
  assert.notEqual(outage.status, "likely-new-after-audited-search", "provider outage never manufactures novelty");
});

test("promotion matrix (spec §18.1): correctness and novelty gates", () => {
  assert.equal(promotionCheck({ candidateType: "record", statement: "x", correctnessStatus: "unverified", noveltyStatus: "unchecked", promotionStatus: "quarantined" }, true).promotionStatus, "quarantined");
  assert.equal(promotionCheck({ candidateType: "conjecture", statement: "x", correctnessStatus: "exactly-verified", noveltyStatus: "unchecked", promotionStatus: "quarantined" }, true).promotionStatus, "candidate");
  assert.equal(promotionCheck({ candidateType: "conjecture", statement: "x", correctnessStatus: "exactly-verified", noveltyStatus: "known", promotionStatus: "quarantined" }, true).promotionStatus, "rejected");
  assert.equal(promotionCheck({ candidateType: "conjecture", statement: "x", correctnessStatus: "exactly-verified", noveltyStatus: "ambiguous", promotionStatus: "quarantined" }, true).promotionStatus, "candidate");
  const ok = promotionCheck({ candidateType: "conjecture", statement: "x", correctnessStatus: "exactly-verified", noveltyStatus: "likely-new-after-audited-search", promotionStatus: "quarantined" }, true);
  assert.equal(ok.promotionStatus, "human-review");
});

// ---- durable job lifecycle (spec §8.6) over real HTTP ----

const SPEC = {
  title: "jobs test", modules: ["mathematics"],
  objective: { statement: "harness", questions: [], deliverables: [], successCriteria: [{ type: "claim_status", value: "verified" }], constraints: [], exclusions: [], assumptions: [], riskClass: "low" },
  models: { defaultPool: [] },
  search: { policy: "round-robin", blindGenerators: 1, maxBranches: 2 },
  budgets: { maxAgentRuns: 10, maxTasks: 10, maxRounds: 1, maxExperiments: 5, wallClockMinutes: 30, maxTokensEstimate: 1e6 },
  autonomy: { level: "L3", humanApprovalRequiredFor: [] },
  workers: { autoSpawn: 0, leaseSeconds: 60 },
  stop: { onSuccess: true, onBudgetExhausted: true, noProgressRounds: 2 },
  verification: { requireIndependentAudit: true },
};

test("job lifecycle: create → PROGRESS metric → complete → stdout artifact + promotion gate e2e", async () => {
  const core = new ResearchCore(fs.mkdtempSync(path.join(os.tmpdir(), "ros-jobs-")));
  core.load();
  const modules = loadModules([path.join(ROOT, "modules")]);
  const scheduler = new Scheduler({ core, modulesFor: (p) => ({ verifiers: verifiersForCampaign(modules, p.state.modules), diversityDescriptors: [], roles: [] }) });
  const { JobRunner } = await import("../jobs.js");
  const runner = new JobRunner(core);
  const server = http.createServer((req, res) => void handleRequest({ core, modulesDir: path.join(ROOT, "modules"), piPackageDir: path.join(ROOT, "pi/research-os-pi"), mesh: { status: async () => ({}), broadcast: async () => ({}) }, jobs: runner }, req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const api = async (method: string, p: string, body?: unknown): Promise<any> => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
  try {
    const created = await api("POST", "/v1/campaigns", { spec: SPEC });
    const cid = created.id;
    // hunt.py fixture: small vdw search that SUCCEEDS fast (W(2,3) era: n=8)
    const job = await api("POST", "/v1/jobs", {
      campaignId: cid, name: "vdw-fixture",
      command: ["python3", path.join(ROOT, "modules", "mathematics", "python", "hunt.py"), "--problem", "vdw", "--n", "8", "--k", "3", "--strategy", "sa", "--seconds", "5", "--seed", "1"],
      cwd: "experiments", wallSeconds: 60,
    });
    assert.ok(job.job.id.startsWith("job:"), `job id: ${job.job.id}`);
    // wait for completion
    let rec;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      rec = await api("GET", `/v1/jobs/${encodeURIComponent(job.job.id)}`);
      if (rec.status !== "running") break;
    }
    assert.equal(rec.status, "completed", `job completed: ${JSON.stringify(rec)}`);
    assert.ok(rec.stdoutArtifactRef, "stdout registered as artifact");
    assert.match(String(rec.metric), /RESULT/);
    const proj = core.requireCampaign(cid);
    assert.equal(proj.jobs.get(job.job.id)?.status, "completed");

    // timeout path: a job that sleeps past its wall budget
    const slow = await api("POST", "/v1/jobs", { campaignId: cid, name: "sleep-forever", command: ["/bin/sleep", "120"], cwd: ".", wallSeconds: 3 });
    let rec2;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      rec2 = await api("GET", `/v1/jobs/${encodeURIComponent(slow.job.id)}`);
      if (rec2.status !== "running") break;
    }
    assert.equal(rec2.status, "timeout", "wall-clock kill works");

    // promotion gate e2e: a record candidate without frontier → refused; with fresh frontier → human-review
    const fsObj = await api("POST", "/v1/objects", {
      campaignId: cid, type: "frontier_snapshot", title: "frontier: W(2,3) lower-bound > 8",
      content: { targetId: "vdw-2-3", capturedAt: new Date().toISOString(), frontierType: "lower-bound", statement: "W(2,3)", currentValue: "8", comparison: ">", improvementPredicate: "coloring of [1,9] with no mono 3-AP", sources: [{ sourceType: "curated", value: "8", date: "2026-01-01" }], sourceAgreement: "agree", confidence: "curated" },
      createdBy: "t", tags: ["frontier"],
    });
    const cand = await api("POST", "/v1/objects", {
      campaignId: cid, type: "discovery_candidate", title: "[record] coloring length 9",
      content: { candidateType: "record", statement: "2-coloring of [1,9] with no mono 3-AP (would give W(2,3) > 9)", correctnessStatus: "exactly-verified", noveltyStatus: "likely-new-after-audited-search", frontierSnapshotId: fsObj.object.id, improvesFrontier: false, promotionStatus: "quarantined" },
      createdBy: "t", tags: ["candidate"],
    });
    const refused = await api("POST", `/v1/candidates/${encodeURIComponent(cand.object.id)}/promote`, { campaignId: cid });
    assert.equal(refused.promoted, false);
    assert.ok(refused.reasons.some((r: string) => r.includes("improvement")), "gate refuses: does not improve frontier (W(2,3)=9!)");
    const cand2 = await api("POST", "/v1/objects", {
      campaignId: cid, type: "discovery_candidate", title: "[record] coloring length 9 v2",
      content: { candidateType: "record", statement: "x", correctnessStatus: "exactly-verified", noveltyStatus: "likely-new-after-audited-search", frontierSnapshotId: fsObj.object.id, improvesFrontier: true, promotionStatus: "quarantined" },
      createdBy: "t", tags: ["candidate"],
    });
    const promoted = await api("POST", `/v1/candidates/${encodeURIComponent(cand2.object.id)}/promote`, { campaignId: cid });
    assert.equal(promoted.promoted, true);
    assert.equal(promoted.promotionStatus, "human-review");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("replay marks interrupted jobs (crash honesty)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ros-jobs2-"));
  const core = new ResearchCore(home);
  core.load();
  const spec = { title: "t", modules: [], objective: { statement: "x", questions: [], deliverables: [], successCriteria: [], constraints: [], exclusions: [], assumptions: [], riskClass: "low" }, models: { defaultPool: [] }, search: { policy: "round-robin", blindGenerators: 1, maxBranches: 4 }, budgets: { maxAgentRuns: 5, maxTasks: 5, maxRounds: 1, maxExperiments: 5, wallClockMinutes: 60, maxTokensEstimate: 1e6 }, autonomy: { level: "L3", humanApprovalRequiredFor: [] }, workers: { autoSpawn: 0, leaseSeconds: 60 }, stop: { onSuccess: true, onBudgetExhausted: true, noProgressRounds: 3 }, verification: { requireIndependentAudit: true } } as never;
  const proj = core.createCampaign(spec, { piPackageDir: "/tmp" });
  core.apply(proj, "campaign.created", { kind: "human", id: "op" }, { spec: { title: "t", modules: [], models: { defaultPool: [] }, search: { policy: "round-robin", blindGenerators: 1, maxBranches: 4 }, budgets: { maxAgentRuns: 5, maxTasks: 5, maxRounds: 1, maxExperiments: 5, wallClockMinutes: 60, maxTokensEstimate: 1e6 }, autonomy: { level: "L3", humanApprovalRequiredFor: [] }, workers: { autoSpawn: 0, leaseSeconds: 60 }, stop: { onSuccess: true, onBudgetExhausted: true, noProgressRounds: 3 }, verification: { requireIndependentAudit: true } } });
  core.apply(proj, "job.created", { kind: "worker", id: "w" }, { job: { id: "job:j_1", campaignId: proj.state.id, name: "x", command: ["x"], cwd: home, status: "running", startedAt: new Date().toISOString(), createdBy: "w" } });
  // fresh core replays: job still running with no live child ⇒ interrupted
  const { JobRunner } = await import("../jobs.js");
  const core2 = new ResearchCore(home);
  core2.load();
  JobRunner.replayInterruptions(core2);
  const reloaded = core2.requireCampaign(proj.state.id);
  assert.equal(reloaded.jobs.get("job:j_1")?.status, "interrupted");
});
