// verifiers2.test.ts — V0.5: new exact functions through the verifier engine,
// certificate verifier (true/cheat), capabilities endpoint.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { ResearchCore, Scheduler, loadModules, verifiersForCampaign, runVerification } from "@research-os/core";
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
  title: "v2 verifiers", modules: ["mathematics"],
  objective: { statement: "harness", questions: [], deliverables: [], successCriteria: [{ type: "claim_status", value: "verified" }], constraints: [], exclusions: [], assumptions: [], riskClass: "low" },
  models: { defaultPool: [] },
  search: { policy: "round-robin", blindGenerators: 1, maxBranches: 2 },
  budgets: { maxAgentRuns: 30, maxTasks: 10, maxRounds: 1, maxExperiments: 5, wallClockMinutes: 10, maxTokensEstimate: 1e6 },
  autonomy: { level: "L3", humanApprovalRequiredFor: [] },
  workers: { autoSpawn: 0, leaseSeconds: 60 },
  stop: { onSuccess: true, onBudgetExhausted: true, noProgressRounds: 2 },
  verification: { requireIndependentAudit: true },
};

async function harness() {
  const core = new ResearchCore(fs.mkdtempSync(path.join(os.tmpdir(), "ros-v5-")));
  core.load();
  const modules = loadModules([path.join(ROOT, "modules")]);
  const scheduler = new Scheduler({ core, modulesFor: (p) => ({ verifiers: verifiersForCampaign(modules, p.state.modules), diversityDescriptors: [], roles: [] }) });
  const server = http.createServer((req, res) => void handleRequest({ core, modulesDir: path.join(ROOT, "modules"), piPackageDir: path.join(ROOT, "pi/research-os-pi"), mesh: { status: async () => ({}), broadcast: async () => ({}) } }, req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const api = async (method: string, p: string, body?: unknown): Promise<any> => {
    const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
  return { core, scheduler, api, modules, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("V0.5.1: mono-variable exact functions reach verified through the engine", async () => {
  const h = await harness();
  try {
    const created = await h.api("POST", "/v1/campaigns", { spec: SPEC });
    const cid = created.id;
    const proj = h.core.requireCampaign(cid);
    const vExh = h.modules.find((m) => m.manifest.id === "mathematics")!.verifiers.find((v) => v.id.includes("exhaustive-finite"))!;

    // Goldbach via goldbach_even on the NATURAL variable (no 2m mapping)
    const c1 = await h.api("POST", "/v1/objects", { campaignId: cid, type: "claim", title: "every even n in [4, 3000] has a prime decomposition", content: {}, bound: { variable: "n", min: 4, max: 3000 }, createdBy: "t" });
    const o1 = await runVerification(h.core, proj, vExh, { targetId: c1.object.id, requestedBy: "t", input: { expression: "goldbach_even(n)+(n%2)", variables: [{ name: "n", min: 3, max: 3000 }], predicate: "greater_than:0" } });
    assert.equal(o1.verification.status, "passed");
    assert.equal(proj.objects.get(c1.object.id)?.epistemicStatus, "verified");

    // Legendre via legendre_gap on the natural variable
    const c2 = await h.api("POST", "/v1/objects", { campaignId: cid, type: "claim", title: "every n in [1, 400] has a prime between n² and (n+1)²", content: {}, bound: { variable: "n", min: 1, max: 400 }, createdBy: "t" });
    const o2 = await runVerification(h.core, proj, vExh, { targetId: c2.object.id, requestedBy: "t", input: { expression: "legendre_gap(n)", variables: [{ name: "n", min: 1, max: 400 }], predicate: "geq:1" } });
    assert.equal(o2.verification.status, "passed");
    assert.equal(proj.objects.get(c2.object.id)?.epistemicStatus, "verified");

    // abc quality exact comparison (Reyssat > 8/5, NOT > 163/100)
    const vPoint = h.modules.find((m) => m.manifest.id === "mathematics")!.verifiers.find((v) => v.id.includes("exact-point"))!;
    const c3 = await h.api("POST", "/v1/objects", { campaignId: cid, type: "claim", title: "Reyssat abc-triple quality exceeds 8/5", content: {}, createdBy: "t" });
    const o3 = await runVerification(h.core, proj, vPoint, { targetId: c3.object.id, requestedBy: "t", input: { expression: "abc_quality_gt(2, 3**10*109, 23**5, 8, 5)", assignment: {}, predicate: "equals:1" } });
    assert.equal(o3.verification.status, "passed");
    assert.equal(proj.objects.get(c3.object.id)?.epistemicStatus, "verified");
  } finally {
    await h.close();
  }
});

test("V0.5.3: certificate verifier — true witness verifies, cheating script rejected", async () => {
  const h = await harness();
  try {
    const created = await h.api("POST", "/v1/campaigns", { spec: SPEC });
    const cid = created.id;
    const proj = h.core.requireCampaign(cid);
    const vCert = h.modules.find((m) => m.manifest.id === "mathematics")!.verifiers.find((v) => v.id.includes("certificate-check"))!;
    assert.ok(vCert, "certificate verifier loaded");

    // TRUE witness: taxicab 1729 = 1³+12³ = 9³+10³
    const c1 = await h.api("POST", "/v1/objects", { campaignId: cid, type: "claim", title: "1729 is a taxicab number (two distinct cube decompositions)", content: {}, createdBy: "t" });
    const o1 = await runVerification(h.core, proj, vCert, {
      targetId: c1.object.id, requestedBy: "t",
      input: {
        script: `def verify(w):\n    a,b,c,d = w["a"],w["b"],w["c"],w["d"]\n    return a**3+b**3 == c**3+d**3 and {a,b} != {c,d}\n`,
        witness: { a: 1, b: 12, c: 9, d: 10 },
        expression: "a*a*a+b*b*b-(c*c*c+d*d*d)",
        predicate: "equals:0",
        allDistinct: ["a", "b", "c", "d"],
      },
    });
    assert.equal(o1.verification.status, "passed", `cert must pass: ${String(o1.verification.output).slice(-300)}`);
    assert.equal(proj.objects.get(c1.object.id)?.epistemicStatus, "verified", "witness certificate verified");

    // CHEAT: verify() returns True but the exact cross-check fails
    const c2 = await h.api("POST", "/v1/objects", { campaignId: cid, type: "claim", title: "bogus taxicab (cheat attempt)", content: {}, createdBy: "t" });
    const o2 = await runVerification(h.core, proj, vCert, {
      targetId: c2.object.id, requestedBy: "t",
      input: {
        script: `def verify(w):\n    return True\n`,
        witness: { a: 1, b: 2, c: 3, d: 4 },
        expression: "a*a*a+b*b*b-(c*c*c+d*d*d)",
        predicate: "equals:0",
      },
    });
    assert.equal(o2.verification.status, "failed");
    assert.notEqual(proj.objects.get(c2.object.id)?.epistemicStatus, "verified", "cheat does not verify");

    // CHEAT 2: script calls sys.exit(0) — runner rejects with error
    const c3 = await h.api("POST", "/v1/objects", { campaignId: cid, type: "claim", title: "exit-control cheat", content: {}, createdBy: "t" });
    const o3 = await runVerification(h.core, proj, vCert, {
      targetId: c3.object.id, requestedBy: "t",
      input: { script: `import sys\nsys.exit(0)\n`, witness: {} },
    });
    assert.equal(o3.verification.status, "failed");
    assert.match(String(o3.verification.output), /control the runner exit|does not define verify/);
  } finally {
    await h.close();
  }
});

test("V0.5.4: capabilities served machine-readable", async () => {
  const h = await harness();
  try {
    const created = await h.api("POST", "/v1/campaigns", { spec: SPEC });
    const out = await h.api("GET", `/v1/verifiers?campaignId=${encodeURIComponent(created.id)}`);
    assert.ok(out.capabilities?.mathematics, "capabilities present");
    assert.ok(out.capabilities.mathematics.functions.some((f: { name: string }) => f.name === "abc_quality_gt"));
    const one = await h.api("GET", "/v1/modules/mathematics/capabilities");
    assert.equal(one.moduleId, "mathematics");
    assert.ok(Array.isArray(one.capabilities.predicates));
  } finally {
    await h.close();
  }
});
