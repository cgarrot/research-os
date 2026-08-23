// creativity.test.ts — V0.6: QD archive derivation, stagnation detection,
// paradigm-break task creation with its dedicated context profile.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { ResearchCore, Scheduler, loadModules, verifiersForCampaign, qdArchive, stagnationSignals, buildContextPack } from "@research-os/core";
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

const SPEC = {
  title: "qd test", modules: ["mathematics"],
  objective: { statement: "harness", questions: [], deliverables: [], successCriteria: [{ type: "claim_status", value: "verified" }], constraints: [], exclusions: [], assumptions: [], riskClass: "low" },
  models: { defaultPool: [] },
  search: { policy: "round-robin", blindGenerators: 2, maxBranches: 12 },
  budgets: { maxAgentRuns: 60, maxTasks: 60, maxRounds: 4, maxExperiments: 10, wallClockMinutes: 30, maxTokensEstimate: 1e6 },
  autonomy: { level: "L3", humanApprovalRequiredFor: [] },
  workers: { autoSpawn: 0, leaseSeconds: 60 },
  stop: { onSuccess: false, onBudgetExhausted: true, noProgressRounds: 9 },
  verification: { requireIndependentAudit: true },
};

async function harness() {
  const core = new ResearchCore(fs.mkdtempSync(path.join(os.tmpdir(), "ros-qd-")));
  core.load();
  const modules = loadModules([path.join(ROOT, "modules")]);
  const notifies: string[] = [];
  const scheduler = new Scheduler({
    core,
    modulesFor: (p) => ({ verifiers: verifiersForCampaign(modules, p.state.modules), diversityDescriptors: ["alpha", "beta", "gamma", "delta"], roles: [] }),
    notify: (_p, m) => notifies.push(m),
  });
  const server = http.createServer((req, res) => void handleRequest({ core, modulesDir: path.join(ROOT, "modules"), piPackageDir: path.join(ROOT, "pi/research-os-pi"), mesh: { status: async () => ({}), broadcast: async () => ({}) } }, req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const api = async (method: string, p: string, body?: unknown): Promise<any> => {
    const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
  return { core, scheduler, api, notifies, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("V0.6.1+2+3: stagnation fixture triggers paradigm-break task with its context profile", async () => {
  const h = await harness();
  try {
    const created = await h.api("POST", "/v1/campaigns", { spec: SPEC });
    const cid = created.id;
    const proj = h.core.requireCampaign(cid);
    await h.api("POST", `/v1/campaigns/${cid}/start`, {});
    h.scheduler.tick();

    // ROUND 1: drain everything, REJECTING all tasks (fixture: universal failure)
    // ROUND 2: same → two rounds with 0 accepted + repeated branch theses → stagnant
    for (let round = 1; round <= 2; round++) {
      for (let guard = 0; guard < 15; guard++) {
        const c = await h.api("POST", "/v1/tasks/claim", { campaignId: cid, workerAlias: "w", mode: "interactive" });
        if (!c.task || c.task.round > round) {
          if (c.task) await h.api("POST", `/v1/tasks/${encodeURIComponent(c.task.id)}/release`, { campaignId: cid, workerAlias: "w", reason: "round boundary" });
          break;
        }
        const t = c.task;
        if (t.phase === "generate") {
          // identical thesis openings → repeated-fingerprint signal
          await h.api("POST", "/v1/branches", { campaignId: cid, thesis: "The dominant alpha strategy refined again toward the same obstruction", methodTags: ["alpha"], createdBy: "w" });
        }
        // submit a FAILURE envelope so nothing is accepted
        const out = await h.api("POST", `/v1/tasks/${encodeURIComponent(t.id)}/result`, {
          campaignId: cid, workerAlias: "w", status: "failure",
          createdObjects: [], createdArtifacts: [], evidence: [], openQuestions: ["why?"],
          blockers: ["obstruction persists"], summary: "blocked again by the same obstruction",
        });
        void out;
        h.scheduler.tick();
      }
    }
    // stagnation signals over the last two rounds
    const sig = stagnationSignals(proj);
    assert.ok(sig.stagnant, `fixture must be stagnant, got: ${JSON.stringify(sig)}`);

    // ROUND 3: generate phase must include a paradigm-break task
    h.scheduler.tick();
    // drive round transition if needed: tasks may already be open
    for (let guard = 0; guard < 20 && ![...proj.tasks.values()].some((t) => t.type === "paradigm-break"); guard++) {
      const c = await h.api("POST", "/v1/tasks/claim", { campaignId: cid, workerAlias: "w", mode: "interactive" });
      if (!c.task) {
        h.scheduler.tick();
        continue;
      }
      await h.api("POST", `/v1/tasks/${encodeURIComponent(c.task.id)}/result`, {
        campaignId: cid, workerAlias: "w", status: "failure", createdObjects: [], createdArtifacts: [], evidence: [],
        openQuestions: [], blockers: ["still stuck"], summary: "no progress this task either",
      });
      h.scheduler.tick();
    }
    const pb = [...proj.tasks.values()].find((t) => t.type === "paradigm-break");
    assert.ok(pb, "paradigm-break task created");
    assert.match(pb.goal, /STAGNATION DETECTED/);

    // context profile: failures-heavy, no optimistic verified facts
    const ctx = buildContextPack(proj, pb);
    assert.equal(ctx.verifiedFacts.length, 0, "no optimistic facts for paradigm-break");
    assert.ok(ctx.relevantFailures.length >= 1, "failures present");

    // QD archive derived
    const niches = qdArchive(proj);
    assert.ok(niches.size >= 1, "qd archive derives from branches");
    assert.ok(h.notifies.some((n) => n.includes("Paradigm-break")), "notify emitted");
  } finally {
    await h.close();
  }
});
