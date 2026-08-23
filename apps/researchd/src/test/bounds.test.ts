// bounds.test.ts — V0.2 integrity: claim-bound binding (strict refusal, heuristic
// flag), skills-as-objects audit fix, worker-death requeue, long-poll claim.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { ResearchCore, Scheduler, loadModules, verifiersForCampaign, checkBoundConsistency, parseVerdict, verdictToDomain, releaseTask } from "@research-os/core";
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
  title: "bounds test", modules: ["mathematics"],
  objective: { statement: "harness", questions: [], deliverables: [], successCriteria: [{ type: "claim_status", value: "verified" }], constraints: [], exclusions: [], assumptions: [], riskClass: "low" },
  models: { defaultPool: [{ id: "zai-glm-5.3", provider: "zai", model: "glm-5.3", runtime: "pi", thinkingLevel: "max", tags: [] }] },
  search: { policy: "round-robin", blindGenerators: 1, maxBranches: 2 },
  budgets: { maxAgentRuns: 5, maxTasks: 10, maxRounds: 1, maxExperiments: 5, wallClockMinutes: 10, maxTokensEstimate: 1000000 },
  autonomy: { level: "L3", humanApprovalRequiredFor: [] },
  workers: { autoSpawn: 0, leaseSeconds: 60 },
  stop: { onSuccess: true, onBudgetExhausted: true, noProgressRounds: 2 },
  verification: { requireIndependentAudit: true },
};

async function harness() {
  const core = new ResearchCore(fs.mkdtempSync(path.join(os.tmpdir(), "ros-bounds-")));
  core.load();
  const modules = loadModules([path.join(ROOT, "modules")]);
  const scheduler = new Scheduler({ core, modulesFor: (proj) => ({ verifiers: verifiersForCampaign(modules, proj.state.modules), diversityDescriptors: [], roles: [] }) });
  const server = http.createServer((req, res) => void handleRequest({ core, modulesDir: path.join(ROOT, "modules"), piPackageDir: path.join(ROOT, "pi", "research-os-pi"), mesh: { status: async () => ({}), broadcast: async () => ({}) } }, req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const api = async (method: string, p: string, body?: unknown): Promise<any> => {
    const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
  return { core, scheduler, api, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const EXHAUSTIVE_OUTPUT = (hi: number) =>
  `$ python3 check.py\n{"mode": "exhaustive", "expression": "n", "variables": [["n", 1, ${hi}]], "testedCases": ${hi}, "totalCases": ${hi}, "predicate": "collatz_terminates", "holds": true}\nexit code: 0`;

test("V0.2.1a: verdict parsing + real coverage mappings", () => {
  const v = parseVerdict(EXHAUSTIVE_OUTPUT(998));
  assert.ok(v);
  const d = verdictToDomain(v as never);
  assert.equal(d.mode, "exhaustive");
  assert.equal(d.realCoverage?.[0]?.max, 998);
  // goldbach 2m mapping
  const g = verdictToDomain({ mode: "exhaustive", expression: "goldbach_count(2*m)+(m%2)", variables: [["m", 5, 50000]] } as never);
  assert.equal(g.realCoverage?.[0]?.max, 100000, "2*hi mapping");
  // legendre m² mapping
  const l = verdictToDomain({ mode: "exhaustive", expression: "prime_pi((m+1)*(m+1))-prime_pi(m*m)", variables: [["m", 1, 998]] } as never);
  assert.ok((l.realCoverage?.[0]?.max ?? 0) >= 998001, "m² window");
});

test("V0.2.1b: STRICT bound mismatch refuses the claim transition (Legendre incident fixture)", async () => {
  const h = await harness();
  try {
    const created = await h.api("POST", "/v1/campaigns", { spec: SPEC });
    const cid = created.id;
    const proj = h.core.requireCampaign(cid);
    // claim announces [1, 20000] with a structured bound (the real c_8 incident)
    const claim = await h.api("POST", "/v1/objects", {
      campaignId: cid, type: "claim", title: "Bounded Legendre: every n in [1,20000] has a prime in (n²,(n+1)²)",
      content: { statement: "for all n in [1,20000]" }, bound: { variable: "n", min: 1, max: 20000 }, createdBy: "test",
    });
    const modules = loadModules([path.join(ROOT, "modules")]);
    const verifier = modules.find((m) => m.manifest.id === "mathematics")!.verifiers.find((v) => v.id.includes("exhaustive-finite"))!;
    // small domain so it actually runs: n in [1, 50] only
    const { runVerification } = await import("@research-os/core");
    const outcome = await runVerification(h.core, proj, verifier, {
      targetId: claim.object.id, requestedBy: "test", input: { expression: "n", variables: [{ name: "n", min: 1, max: 50 }], predicate: "prime" },
    });
    assert.ok(outcome.boundRefused, "transition must be refused");
    assert.ok(["speculative", "unverified"].includes(String(proj.objects.get(claim.object.id)?.epistemicStatus)), "claim stays un-promoted");
    assert.equal(proj.objects.get(claim.object.id)?.content.flaggedBound, true, "claim flagged");
  } finally {
    await h.close();
  }
});

test("V0.2.1c: heuristic flags legacy overstatement but transition stands; honest bound passes clean", async () => {
  const h = await harness();
  try {
    const created = await h.api("POST", "/v1/campaigns", { spec: SPEC });
    const cid = created.id;
    const proj = h.core.requireCampaign(cid);
    const modules = loadModules([path.join(ROOT, "modules")]);
    const verifier = modules.find((m) => m.manifest.id === "mathematics")!.verifiers.find((v) => v.id.includes("exhaustive-finite"))!;
    const { runVerification } = await import("@research-os/core");

    // legacy claim without bound: announces 1000000, verified only 300
    const c1 = await h.api("POST", "/v1/objects", { campaignId: cid, type: "claim", title: "all n in [1, 1000000] are odd-or-even", content: { statement: "n is an integer for n <= 1000000" }, createdBy: "test" });
    await runVerification(h.core, proj, verifier, { targetId: c1.object.id, requestedBy: "test", input: { expression: "n", variables: [{ name: "n", min: 1, max: 300 }], predicate: "odd" } });
    // predicate odd fails at n=2 → falsified path with counterexample; use leq-ish predicate instead:
    // (use divisible check that holds)
    const c2 = await h.api("POST", "/v1/objects", { campaignId: cid, type: "claim", title: "all n in [1, 1000000] satisfy trivial identity", content: {}, createdBy: "test" });
    const out2 = await runVerification(h.core, proj, verifier, { targetId: c2.object.id, requestedBy: "test", input: { expression: "n*1", variables: [{ name: "n", min: 1, max: 300 }], predicate: "greater_than:0" } });
    assert.equal(out2.verification.status, "passed");
    const obj2 = proj.objects.get(c2.object.id);
    assert.equal(obj2?.epistemicStatus, "verified", "legacy transition stands");
    assert.equal(obj2?.content.flaggedBound, true, "but flagged: announced 1e6 vs verified 300");
    assert.ok(obj2?.content.verifiedDomain, "domain attached to claim");

    // honest claim: verified 5 000 000, no bound field needed (Collatz-style title)
    const c3 = await h.api("POST", "/v1/objects", { campaignId: cid, type: "claim", title: "holds for all n in [1, 500]", content: {}, createdBy: "test" });
    const out3 = await runVerification(h.core, proj, verifier, { targetId: c3.object.id, requestedBy: "test", input: { expression: "n*1", variables: [{ name: "n", min: 1, max: 500 }], predicate: "greater_than:0" } });
    assert.equal(out3.verification.status, "passed");
    const obj3 = proj.objects.get(c3.object.id);
    assert.equal(obj3?.epistemicStatus, "verified");
    assert.notEqual(obj3?.content.flaggedBound, true, "honest claim not flagged");
    // replay keeps it all
    const events = proj.store.readAll();
    const core2 = new ResearchCore(path.dirname(proj.workspaceDir));
    // simulate fresh core over same home: reuse same rootDir
    const core3 = new ResearchCore(h.core.rootDir);
    core3.load();
    const p3 = core3.requireCampaign(cid);
    assert.equal(p3.objects.get(c3.object.id)?.epistemicStatus, "verified", "verified survives replay");
    assert.equal(p3.objects.get(c2.object.id)?.content.flaggedBound, true, "flag survives replay");
    assert.ok(events.length > 0);
  } finally {
    await h.close();
  }
});

test("V0.2.2: result envelope referencing a fresh skill is accepted", async () => {
  const h = await harness();
  try {
    const created = await h.api("POST", "/v1/campaigns", { spec: { ...SPEC, objective: { ...SPEC.objective, successCriteria: [{ type: "claim_status", value: "falsified" }] } } });
    const cid = created.id;
    const proj = h.core.requireCampaign(cid);
    h.scheduler.tick();
    await h.api("POST", `/v1/campaigns/${cid}/start`, {});
    h.scheduler.tick();
    const task = [...proj.tasks.values()].find((t) => t.status === "queued");
    assert.ok(task, "task queued");
    const claimed = await h.api("POST", "/v1/tasks/claim", { campaignId: cid, workerAlias: "w", mode: "interactive" });
    const skill = await h.api("POST", "/v1/skills", { campaignId: cid, name: "test-skill", activation: ["a"], procedure: ["b"], evidenceRefs: [], createdBy: "w" });
    const q = await h.api("POST", "/v1/objects", { campaignId: cid, type: "question", title: "q", content: { text: "x" }, createdBy: "w" });
    const out = await h.api("POST", `/v1/tasks/${encodeURIComponent(claimed.task.id)}/result`, {
      campaignId: cid, workerAlias: "w", status: "success", createdObjects: [skill.skill.id, q.object.id],
      summary: "used the skill and delivered a full honest summary of the grounding work done here",
    });
    assert.equal(out.accepted, true, `skill ref must be accepted: ${JSON.stringify(out.audit ?? {})}`);
  } finally {
    await h.close();
  }
});

test("V0.2.4: claim long-poll waits then returns null / picks late task", async () => {
  const h = await harness();
  try {
    const created = await h.api("POST", "/v1/campaigns", { spec: SPEC });
    const cid = created.id;
    await h.api("POST", `/v1/campaigns/${cid}/start`, {});
    h.scheduler.tick();
    const proj = h.core.requireCampaign(cid);
    const task = [...proj.tasks.values()].find((t) => t.status === "queued");
    assert.ok(task);
    // take it with an immediate claim
    const c1 = await h.api("POST", "/v1/tasks/claim", { campaignId: cid, workerAlias: "a", mode: "interactive" });
    assert.ok(c1.task);
    // long-poll on an empty queue: should wait ~3s then return null
    const t0 = Date.now();
    const c2 = await h.api("POST", "/v1/tasks/claim", { campaignId: cid, workerAlias: "b", mode: "interactive", waitSeconds: 3 });
    assert.equal(c2.task, null);
    assert.ok(c2.waitedMs >= 2500, `waitedMs=${c2.waitedMs}`);
    assert.ok(Date.now() - t0 >= 2500);
    // release, then long-poll again with a task arriving via release-requeue after 1s
    setTimeout(() => {
      void releaseTask(h.core, h.core.requireCampaign(cid), c1.task.id, "a", "test release");
    }, 1000);
    const c3 = await h.api("POST", "/v1/tasks/claim", { campaignId: cid, workerAlias: "b", mode: "interactive", waitSeconds: 10 });
    assert.ok(c3.task, "requeued task picked up during long-poll");
  } finally {
    await h.close();
  }
});

test("checkBoundConsistency: point/symbolic modes never flag", () => {
  const claim = { title: "witness pair (5,7)", content: { statement: "5+7" } };
  const d = verdictToDomain({ mode: "point", expression: "a+b", assignment: { a: 5, b: 7 }, predicate: "equals:12" } as never);
  const check = checkBoundConsistency(claim as never, d);
  assert.equal(check.flagged, false);
});
