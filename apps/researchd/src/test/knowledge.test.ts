// knowledge.test.ts — v0.3 consolidation + injection: idempotent extraction,
// bound parsing (verifiedDomain + title fallback), lookup, anti-duplication,
// priorRuns injection into ContextPacks.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import {
  ResearchCore,
  Scheduler,
  loadModules,
  verifiersForCampaign,
  openKnowledge,
  consolidate,
  lookup,
  bestBound,
  extractKnowledge,
  setPriorRunsLookup,
  setProblemSlugMap,
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

function fakeEvents(problem: string): never[] {
  const cid = "campaign:c_99";
  const now = new Date().toISOString();
  const ev = (type: string, payload: Record<string, unknown>): never => ({ id: "event:e", campaignId: cid, type, timestamp: now, actor: { kind: "worker", id: "w" }, payload, schemaVersion: 1 }) as never;
  return [
    ev("campaign.created", { spec: { title: problem } }),
    ev("object.created", { object: { id: "claim:cl_1", type: "claim", title: `Bounded claim: holds for all n in [1, 2,000,000]`, content: {}, epistemicStatus: "unverified", tags: [], createdAt: now, updatedAt: now } }),
    ev("claim.status_changed", { objectId: "claim:cl_1", from: "unverified", to: "verified", via: "verification:v_1" }),
    ev("object.created", { object: { id: "claim:cl_2", type: "claim", title: "false lemma dies", content: {}, epistemicStatus: "unverified", tags: [], createdAt: now, updatedAt: now } }),
    ev("claim.status_changed", { objectId: "claim:cl_2", from: "unverified", to: "falsified", via: "verification:v_2" }),
    ev("memory.episode_created", { memory: { id: "memory:m_1", kind: "negative", title: "Dead end: X fails because Y", content: {} } }),
    ev("memory.skill_candidate_created", { skill: { id: "skill:sk_1", name: "useful-skill", procedure: ["step1", "step2"], verificationState: "candidate", citations: 0 } }),
  ];
}

test("consolidation: extraction, idempotence, title-bound fallback, lookup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kn-"));
  const store = openKnowledge(dir);
  const events = fakeEvents("xx-test-problem");
  const r1 = consolidate(store, events, "xx-test-problem");
  assert.equal(r1.added, 3, "verified claim + falsified claim + dead-end (candidate skill with 0 citations excluded)");
  const r2 = consolidate(store, events, "xx-test-problem");
  assert.equal(r2.added, 0, "idempotent");
  assert.equal(r2.skipped, r1.added);

  const lk = lookup(store, "xx-test-problem");
  assert.equal(lk.covered, true);
  assert.equal(lk.runs, 1);
  assert.equal(lk.verifiedClaims.length, 1);
  assert.equal(lk.deadEnds.length, 1);
  assert.equal(lk.bounds.length, 1, "title-bound fallback extracted");
  assert.equal(lk.bounds[0].max, 2000000, "2,000,000 parsed from '[1, 2,000,000]'");
  const bb = bestBound(store, "xx-test-problem");
  assert.equal(bb?.max, 2000000);
  // unknown problem
  const none = lookup(store, "yy-unknown");
  assert.equal(none.covered, false);
});

test("verifiedDomain bound preferred over title parsing", () => {
  const events = fakeEvents("xx-dom");
  // add a verifiedDomain to the verified claim via a real campaign shape
  const store = openKnowledge(fs.mkdtempSync(path.join(os.tmpdir(), "kn2-")));
  const withDomain = events.map((e) => {
    if ((e as { type: string }).type === "claim.status_changed" && (e as never as { payload: { to: string } }).payload.to === "verified") return e;
    return e;
  });
  // simulate: the object carries verifiedDomain
  const enriched = withDomain.map((e) => {
    const ev = e as unknown as { type: string; payload: { object?: { id: string; content?: Record<string, unknown> } } };
    if (ev.type === "object.created" && ev.payload.object?.id === "claim:cl_1") {
      ev.payload.object.content = { verifiedDomain: { realCoverage: [{ variable: "n", min: 3, max: 5000 }] } };
    }
    return e;
  }) as never[];
  consolidate(store, enriched, "xx-dom");
  const bb = bestBound(store, "xx-dom");
  assert.equal(bb?.max, 5000, "verifiedDomain wins over the 2,000,000 title");
});

test("priorRuns injected into ContextPack when problem knowledge exists (e2e)", async () => {
  // build knowledge for a problem, then run a campaign whose workspace maps to it
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kn3-"));
  const store = openKnowledge(dir);
  consolidate(store, fakeEvents("yy-prior-problem"), "yy-prior-problem");
  const lk = lookup(store, "yy-prior-problem");

  setPriorRunsLookup((slug) => (slug === "yy-prior-problem" ? lk : null));
  const core = new ResearchCore(dir);
  core.load();
  const modules = loadModules([path.join(ROOT, "modules")]);
  const scheduler = new Scheduler({ core, modulesFor: (p) => ({ verifiers: verifiersForCampaign(modules, p.state.modules), diversityDescriptors: [], roles: [] }) });
  const server = http.createServer((req, res) => void handleRequest({ core, modulesDir: path.join(ROOT, "modules"), piPackageDir: path.join(ROOT, "pi/research-os-pi"), mesh: { status: async () => ({}), broadcast: async () => ({}) } }, req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const api = async (method: string, p: string, body?: unknown): Promise<any> => {
    const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return JSON.parse(await res.text());
  };
  try {
    const created = await api("POST", "/v1/campaigns", { spec: {
      title: "prior", modules: ["mathematics"],
      objective: { statement: "x", questions: [], deliverables: [], successCriteria: [{ type: "claim_status", value: "verified" }], constraints: [], exclusions: [], assumptions: [], riskClass: "low" },
      models: { defaultPool: [] }, search: { policy: "round-robin", blindGenerators: 1, maxBranches: 2 },
      budgets: { maxAgentRuns: 5, maxTasks: 10, maxRounds: 1, maxExperiments: 5, wallClockMinutes: 30, maxTokensEstimate: 1e6 },
      autonomy: { level: "L3", humanApprovalRequiredFor: [] }, workers: { autoSpawn: 0, leaseSeconds: 60 },
      stop: { onSuccess: true, onBudgetExhausted: true, noProgressRounds: 2 }, verification: { requireIndependentAudit: true },
    } });
    await api("POST", `/v1/campaigns/${created.id}/start`, {});
    scheduler.tick();
    setProblemSlugMap(new Map([[path.resolve(created.workspace), "yy-prior-problem"]]));
    const claimed = await api("POST", "/v1/tasks/claim", { campaignId: created.id, workerAlias: "w", mode: "interactive" });
    const ctx = claimed.context ?? {};
    assert.ok(ctx.priorRuns, "priorRuns present in ContextPack");
    assert.equal(ctx.priorRuns.runs, 1);
    assert.match(ctx.priorRuns.instruction, /EXTEND, DON'T REPEAT/i);
    assert.ok(ctx.priorRuns.bounds.some((b: string) => b.includes("2,000,000")));
  } finally {
    setPriorRunsLookup(null);
    await new Promise<void>((r) => server.close(() => r()));
  }
});
