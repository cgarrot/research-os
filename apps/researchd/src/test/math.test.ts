// math.test.ts — mathematics module engine tests (no LLM): verifiers,
// module prompts injection, module skills scaffolding.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  ResearchCore,
  Scheduler,
  loadModules,
  verifiersForCampaign,
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

const SPEC = {
  title: "math module engine test",
  modules: ["mathematics"],
  objective: {
    statement: "Engine test harness.",
    questions: [],
    deliverables: [],
    successCriteria: [{ type: "claim_status", value: "verified", description: "bounded verification" }],
    constraints: [], exclusions: [], assumptions: [], riskClass: "low",
  },
  models: { defaultPool: [{ id: "zai-glm-5.3", provider: "zai", model: "glm-5.3", runtime: "pi", thinkingLevel: "max", tags: [] }] },
  search: { policy: "round-robin", blindGenerators: 1, maxBranches: 2 },
  budgets: { maxAgentRuns: 5, maxTasks: 10, maxRounds: 1, maxExperiments: 5, wallClockMinutes: 10, maxTokensEstimate: 1_000_000 },
  autonomy: { level: "L3", humanApprovalRequiredFor: [] },
  workers: { autoSpawn: 0, leaseSeconds: 120 },
  stop: { onSuccess: true, onBudgetExhausted: true, noProgressRounds: 2 },
  verification: { requireIndependentAudit: true },
};

test("math module: verifiers, prompts injection, skills scaffolding", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "researchos-math-"));
  const core = new ResearchCore(home);
  core.load();
  const modules = loadModules([path.join(ROOT, "modules")]);
  const math = modules.find((m) => m.manifest.id === "mathematics");
  assert.ok(math, "mathematics module loads");
  assert.ok(math.verifiers.length >= 6, `six+ exec verifiers (got ${math.verifiers.length})`);
  assert.equal(math.skills.length, 7, "seven seed skills");

  const scheduler = new Scheduler({
    core,
    modulesFor: (proj) => ({
      verifiers: verifiersForCampaign(modules, proj.state.modules),
      diversityDescriptors: math.manifest.diversityDescriptors,
      roles: [],
    }),
  });
  const server = http.createServer((req, res) =>
    void handleRequest(
      { core, modulesDir: path.join(ROOT, "modules"), piPackageDir: path.join(ROOT, "pi", "research-os-pi"), mesh: { status: async () => ({}), broadcast: async () => ({}) } },
      req, res,
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const api = async (method: string, p: string, body?: unknown): Promise<any> => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };

  try {
    const created = await api("POST", "/v1/campaigns", { spec: SPEC });
    const cid = created.id;

    // module seed skills scaffolded into the campaign workspace
    const ws = created.workspace as string;
    assert.ok(fs.existsSync(path.join(ws, ".pi/skills/bounded-verification/SKILL.md")), "bounded-verification skill scaffolded");
    assert.ok(fs.existsSync(path.join(ws, ".pi/skills/exact-arithmetic-first/SKILL.md")), "exact-arithmetic-first skill scaffolded");

    // module prompts stored in campaign state (replay-safe)
    const proj = core.requireCampaign(cid);
    assert.ok(proj.state.modulePrompts?.["test"]?.includes("exhaustive-finite"), "phase prompts stored");

    await api("POST", `/v1/campaigns/${cid}/start`, {});
    scheduler.tick();
    // module guidance injected into the ground task goal
    const groundTask = [...proj.tasks.values()].find((t) => t.phase === "ground");
    assert.ok(groundTask, "ground task created");
    assert.match(groundTask!.goal, /Module guidance \(mathematics\)/, "module guidance in task goal");
    // release without executing (we only test scaffolding here)
    await api("POST", `/v1/tasks/${encodeURIComponent(groundTask!.id)}/release`, { campaignId: cid, workerAlias: "test", reason: "scaffold check" });

    // --- exhaustive-finite: bounded Collatz claim becomes VERIFIED
    const claim1 = await api("POST", "/v1/objects", {
      campaignId: cid, type: "claim", title: "Collatz holds for all n in [1, 5000]",
      content: { statement: "For every integer n with 1 <= n <= 5000, the Collatz iteration reaches 1." },
      createdBy: "test",
    });
    const v1 = await api("POST", "/v1/verifications", {
      campaignId: cid, targetId: claim1.object.id, verifierId: "mathematics:exhaustive-finite",
      requestedBy: "test", input: { expression: "n", variables: [{ name: "n", min: 1, max: 5000 }], predicate: "collatz_terminates" },
    });
    assert.equal(v1.verification.status, "passed", "exhaustive check passes");
    assert.equal(core.requireCampaign(cid).objects.get(claim1.object.id)?.epistemicStatus, "verified", "bounded claim VERIFIED (M4)");

    // --- exact-counterexample: a plausible false lemma gets FALSIFIED
    const claim2 = await api("POST", "/v1/objects", {
      campaignId: cid, type: "claim", title: "All n <= 100 finish Collatz in under 100 steps",
      content: { statement: "For every n in [1,100], collatz_steps(n) < 100." },
      createdBy: "test",
    });
    const v2 = await api("POST", "/v1/verifications", {
      campaignId: cid, targetId: claim2.object.id, verifierId: "mathematics:exact-counterexample",
      requestedBy: "test", input: { expression: "n", assignment: { n: 27 }, predicate: "collatz_steps_greater_than:100" },
    });
    assert.equal(v2.verification.status, "passed", "counterexample witness confirmed");
    assert.equal(core.requireCampaign(cid).objects.get(claim2.object.id)?.epistemicStatus, "falsified", "false lemma FALSIFIED_EXACT via n=27");

    // --- numerical-evidence: partial range → empirically_supported only
    const claim3 = await api("POST", "/v1/objects", {
      campaignId: cid, type: "claim", title: "Collatz steps stay modest (partial support)",
      content: { statement: "For sampled n in [1, 100000], collatz_steps(n) < 400." },
      createdBy: "test",
    });
    const v3 = await api("POST", "/v1/verifications", {
      campaignId: cid, targetId: claim3.object.id, verifierId: "mathematics:numerical-evidence",
      requestedBy: "test", input: { expression: "n", variables: [{ name: "n", min: 1, max: 100000 }], predicate: "collatz_steps_less_than:400" },
    });
    assert.equal(v3.verification.status, "passed");
    assert.equal(core.requireCampaign(cid).objects.get(claim3.object.id)?.epistemicStatus, "empirically_supported", "partial evidence stays M2, never verified");

    // --- symbolic-identity: binomial identity VERIFIED
    const claim4 = await api("POST", "/v1/objects", {
      campaignId: cid, type: "claim", title: "Algebraic identity",
      content: { statement: "(x+y)^2 = x^2 + 2xy + y^2 for all x, y." },
      createdBy: "test",
    });
    const v4 = await api("POST", "/v1/verifications", {
      campaignId: cid, targetId: claim4.object.id, verifierId: "mathematics:symbolic-identity",
      requestedBy: "test", input: { left: "(x+y)^2", right: "x^2+2*x*y+y^2", variables: ["x", "y"] },
    });
    assert.equal(v4.verification.status, "passed");
    assert.equal(core.requireCampaign(cid).objects.get(claim4.object.id)?.epistemicStatus, "verified");

    // --- verifier isolation: mathematics verifier refused for a campaign without the module
    const other = await api("POST", "/v1/campaigns", { spec: { ...SPEC, modules: ["mathematics-lite"], title: "no-math" } });
    await assert.rejects(
      () => api("POST", "/v1/verifications", { campaignId: other.id, targetId: "claim:cl_1", verifierId: "mathematics:exhaustive-finite", input: {} }),
      /not part of campaign modules/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
