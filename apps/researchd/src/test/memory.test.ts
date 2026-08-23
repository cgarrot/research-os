// memory.test.ts — V0.4: global negative memory injection, skill citations →
// activation, skillsUsable plumbed through submit.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { ResearchCore, Scheduler, loadModules, verifiersForCampaign, setGlobalContextSources, relevantGlobalLessons } from "@research-os/core";
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
  title: "mem test", modules: ["mathematics"],
  objective: { statement: "collatz bounded work", questions: [], deliverables: [], successCriteria: [{ type: "claim_status", value: "verified" }], constraints: [], exclusions: [], assumptions: [], riskClass: "low" },
  models: { defaultPool: [] },
  search: { policy: "round-robin", blindGenerators: 1, maxBranches: 2 },
  budgets: { maxAgentRuns: 40, maxTasks: 10, maxRounds: 1, maxExperiments: 5, wallClockMinutes: 10, maxTokensEstimate: 1e6 },
  autonomy: { level: "L3", humanApprovalRequiredFor: [] },
  workers: { autoSpawn: 0, leaseSeconds: 60 },
  stop: { onSuccess: true, onBudgetExhausted: true, noProgressRounds: 2 },
  verification: { requireIndependentAudit: true },
};

async function harness() {
  const core = new ResearchCore(fs.mkdtempSync(path.join(os.tmpdir(), "ros-mem-")));
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
  return { core, scheduler, api, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("V0.4.1: global lessons injected into another campaign's ContextPack", async () => {
  setGlobalContextSources({
    lessons: [{ title: "Failure: collatz scan cap exceeded in campaign X", content: { blockers: ["5M case cap"] }, campaignId: "campaign:c_99" }],
    skills: [{ name: "exact-c-census", activation: ["c search"], procedure: ["write C", "shard"], state: "active", citations: 3 }],
  });
  const h = await harness();
  try {
    const created = await h.api("POST", "/v1/campaigns", { spec: SPEC });
    const cid = created.id;
    await h.api("POST", `/v1/campaigns/${cid}/start`, {});
    h.scheduler.tick();
    const proj = h.core.requireCampaign(cid);
    const task = [...proj.tasks.values()].find((t) => t.status === "queued");
    assert.ok(task);
    const claimed = await h.api("POST", "/v1/tasks/claim", { campaignId: cid, workerAlias: "w", mode: "interactive" });
    const ctx = claimed.context ?? {};
    assert.ok(Array.isArray(ctx.globalLessons) && ctx.globalLessons.length > 0, "global lessons injected");
    assert.match(String(ctx.globalLessons[0].title), /collatz scan cap/);
    assert.ok(Array.isArray(ctx.relevantSkills) && ctx.relevantSkills.some((s: { title?: string }) => String(s.title).includes("exact-c-census")), "global skill injected into relevantSkills");
  } finally {
    setGlobalContextSources(null);
    await h.close();
  }
});

test("V0.4.2: skillsUsed citations counted and candidate → active at 2 citations (round close)", async () => {
  const h = await harness();
  try {
    const created = await h.api("POST", "/v1/campaigns", { spec: SPEC });
    const cid = created.id;
    const proj = h.core.requireCampaign(cid);
    await h.api("POST", `/v1/campaigns/${cid}/start`, {});
    h.scheduler.tick();
    const skill = await h.api("POST", "/v1/skills", { campaignId: cid, name: "test-cite-skill", activation: ["a"], procedure: ["b"], evidenceRefs: [], createdBy: "w" });
    // round 1: claim ground, submit twice with skillsUsed (two tasks via requeue trick is complex —
    // cite once in round 1, verify citation counted; then force a round close via scheduler tick
    // after submitting the ground task; skill needs 2 → cite again on a second accepted task.
    const claimed = await h.api("POST", "/v1/tasks/claim", { campaignId: cid, workerAlias: "w", mode: "interactive" });
    const q = await h.api("POST", "/v1/objects", { campaignId: cid, type: "question", title: "q", content: { text: "x" }, createdBy: "w" });
    const out1 = await h.api("POST", `/v1/tasks/${encodeURIComponent(claimed.task.id)}/result`, {
      campaignId: cid, workerAlias: "w", status: "success", createdObjects: [q.object.id],
      summary: "grounded thoroughly with skill applied", skillsUsed: [skill.skill.id],
    });
    assert.equal(out1.accepted, true);
    assert.equal(proj.skills.get(skill.skill.id)?.citations, 1, "citation counted");

    // drain remaining phases citing again (test phase if any) — use generate next
    h.scheduler.tick();
    for (let guard = 0; guard < 10; guard++) {
      const c = await h.api("POST", "/v1/tasks/claim", { campaignId: cid, workerAlias: "w2", mode: "interactive" });
      if (!c.task) break;
      const objs = c.task.expectedOutputs?.requiredObjectTypes ?? [];
      const made: string[] = [];
      for (const type of objs) {
        const o = await h.api("POST", "/v1/objects", { campaignId: cid, type, title: `${type}`, content: { text: "x" }, createdBy: "w2" });
        made.push(o.object.id);
      }
      if (made.length === 0) {
        const o = await h.api("POST", "/v1/objects", { campaignId: cid, type: "observation", title: "o", content: { text: "x" }, createdBy: "w2" });
        made.push(o.object.id);
      }
      await h.api("POST", `/v1/tasks/${encodeURIComponent(c.task.id)}/result`, {
        campaignId: cid, workerAlias: "w2", status: "success", createdObjects: made,
        summary: "done with skill applied again", skillsUsed: [skill.skill.id],
      });
      h.scheduler.tick();
      if (proj.skills.get(skill.skill.id)?.verificationState === "active") break;
    }
    assert.equal(proj.skills.get(skill.skill.id)?.verificationState, "active", "skill activated at 2 citations");
  } finally {
    await h.close();
  }
});

test("relevantGlobalLessons ranks matching lessons first", () => {
  const items = relevantGlobalLessons(
    [
      { hash: "a", campaignId: "c1", kind: "negative", title: "collatz cap blowup", content: {}, createdAt: "" },
      { hash: "b", campaignId: "c2", kind: "negative", title: "graph coloring timeout", content: {}, createdAt: "" },
    ],
    "collatz bounded verification",
    2,
  );
  assert.match(items[0].title, /collatz/);
});
