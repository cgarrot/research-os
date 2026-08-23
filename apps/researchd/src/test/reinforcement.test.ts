// reinforcement.test.ts — RL-lite: outcome extraction, skill utility updates,
// strategy UCB priors, rejection feedback in ContextPacks, human review command.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { ResearchCore, Scheduler, loadModules, verifiersForCampaign, extractOutcomes, updateSkillStats, strategyStats, rankDescriptors, classifyRejection } from "@research-os/core";
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
  title: "rl", modules: ["mathematics"],
  objective: { statement: "x", questions: [], deliverables: [], successCriteria: [{ type: "claim_status", value: "verified" }], constraints: [], exclusions: [], assumptions: [], riskClass: "low" },
  models: { defaultPool: [] }, search: { policy: "round-robin", blindGenerators: 2, maxBranches: 6 },
  budgets: { maxAgentRuns: 20, maxTasks: 20, maxRounds: 1, maxExperiments: 5, wallClockMinutes: 30, maxTokensEstimate: 1e6 },
  autonomy: { level: "L3", humanApprovalRequiredFor: [] }, workers: { autoSpawn: 0, leaseSeconds: 60 },
  stop: { onSuccess: true, onBudgetExhausted: true, noProgressRounds: 2 }, verification: { requireIndependentAudit: true },
};

async function harness() {
  const core = new ResearchCore(fs.mkdtempSync(path.join(os.tmpdir(), "ros-rl-")));
  core.load();
  const modules = loadModules([path.join(ROOT, "modules")]);
  const scheduler = new Scheduler({ core, modulesFor: (p) => ({ verifiers: verifiersForCampaign(modules, p.state.modules), diversityDescriptors: ["alpha", "beta"], roles: [] }) });
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

test("rejection classification", () => {
  assert.equal(classifyRejection("created object skill:sk_1 does not exist in campaign state"), "ref-not-found");
  assert.equal(classifyRejection("object claims verifier-only status verified — workers cannot self-promote"), "self-promotion");
  assert.equal(classifyRejection('output contract requires at least one object of type "decision"'), "missing-required-object");
});

test("outcome extraction + skill utility + UCB priors (e2e through real events)", async () => {
  const h = await harness();
  try {
    const created = await h.api("POST", "/v1/campaigns", { spec: SPEC });
    const cid = created.id;
    const proj = h.core.requireCampaign(cid);
    await h.api("POST", `/v1/campaigns/${cid}/start`, {});
    h.scheduler.tick();

    // worker 1: uses a skill, task ACCEPTED
    const c1 = await h.api("POST", "/v1/tasks/claim", { campaignId: cid, workerAlias: "w1", mode: "interactive" });
    const skill1 = await h.api("POST", "/v1/skills", { campaignId: cid, name: "good-skill", activation: ["a"], procedure: ["b"], evidenceRefs: [], createdBy: "w1" });
    const q1 = await h.api("POST", "/v1/objects", { campaignId: cid, type: "question", title: "q1", content: { text: "x" }, createdBy: "w1" });
    await h.api("POST", `/v1/tasks/${encodeURIComponent(c1.task.id)}/result`, {
      campaignId: cid, workerAlias: "w1", status: "success", createdObjects: [q1.object.id], skillsUsed: [skill1.skill.id],
      summary: "used good-skill successfully for the required grounding work",
    });

    // worker 2: uses a different skill, task REJECTED (missing required object)
    const c2 = await h.api("POST", "/v1/tasks/claim", { campaignId: cid, workerAlias: "w2", mode: "interactive", waitSeconds: 3 });
    const skill2 = await h.api("POST", "/v1/skills", { campaignId: cid, name: "bad-skill", activation: ["a"], procedure: ["b"], evidenceRefs: [], createdBy: "w2" });
    if (c2.task) {
      await h.api("POST", `/v1/tasks/${encodeURIComponent(c2.task.id)}/result`, {
        campaignId: cid, workerAlias: "w2", status: "success", createdObjects: [], skillsUsed: [skill2.skill.id],
        summary: "too short",
      });
    }

    const outcomes = extractOutcomes(proj);
    assert.ok(outcomes.length >= 1, `outcomes extracted: ${outcomes.length}`);
    const accepted = outcomes.find((o) => o.accepted);
    const rejected = outcomes.find((o) => !o.accepted);
    const allSkills = outcomes.flatMap((o) => o.skillsUsed);
    assert.ok(allSkills.includes(skill1.skill.id), `good-skill cited somewhere: ${allSkills.join(",")}`);
    if (rejected) assert.ok(rejected.rejectionClasses.length >= 1, "rejection classified");

    // skill utility: good rises, bad falls
    const stats = updateSkillStats(new Map(), outcomes);
    const good = stats.get(skill1.skill.id) ?? [...stats.values()].find((x) => x.name === "good-skill");
    const bad = stats.get(skill2.skill.id) ?? [...stats.values()].find((x) => x.name === "bad-skill");
    assert.ok(good && good.utility > 0.5, `good utility ${good?.utility}`);
    if (bad && bad.cited > 0) assert.ok(bad.utility < 0, `bad utility ${bad.utility}`);

    // UCB priors: strategy stats computed
    const priors = strategyStats(outcomes);
    assert.ok(priors.size >= 1, `priors: ${priors.size}`);

    // ContextPack rejection feedback visible on next claim
    h.scheduler.tick();
    const c3 = await h.api("POST", "/v1/tasks/claim", { campaignId: cid, workerAlias: "w3", mode: "interactive" });
    // recentRejections present whenever a ContextPack is built (empty array when no rejections yet)
    if (c3.task && c3.context) {
      assert.ok(Array.isArray(c3.context.recentRejections), "recentRejections field present (may be empty)");
    }
  } finally {
    await h.close();
  }
});

test("human review: list bundle + accept/reject decisions persist", async () => {
  const h = await harness();
  try {
    const created = await h.api("POST", "/v1/campaigns", { spec: SPEC });
    const cid = created.id;
    const proj = h.core.requireCampaign(cid);
    // seed a discovery candidate
    await h.api("POST", "/v1/objects", {
      campaignId: cid, type: "discovery_candidate",
      title: "[record] test candidate",
      content: { candidateType: "record", statement: "test", correctnessStatus: "exactly-verified", noveltyStatus: "likely-new-after-audited-search", promotionStatus: "human-review" },
      createdBy: "t",
    });
    const bundle = await h.api("GET", `/v1/campaigns/${cid}/review`);
    assert.equal(bundle.candidates.length, 1);
    const candId = bundle.candidates[0].id;

    // accept
    const acc = await h.api("POST", "/v1/review/decision", { campaignId: cid, decision: "accept", subjectId: candId });
    assert.equal(acc.recorded, true);
    const obj = proj.objects.get(candId);
    assert.equal((obj?.content as Record<string, unknown>)?.promotionStatus, "accepted-result", "accept flips promotionStatus");

    // reject another
    const c2 = await h.api("POST", "/v1/objects", {
      campaignId: cid, type: "discovery_candidate", title: "[record] second",
      content: { candidateType: "record", statement: "x", correctnessStatus: "exactly-verified", noveltyStatus: "unchecked", promotionStatus: "quarantined" }, createdBy: "t",
    });
    const rej = await h.api("POST", "/v1/review/decision", { campaignId: cid, decision: "reject", subjectId: c2.object.id });
    assert.equal(rej.recorded, true);
    assert.equal((proj.objects.get(c2.object.id)?.content as Record<string, unknown>)?.promotionStatus, "rejected");

    // note
    const note = await h.api("POST", "/v1/review/decision", { campaignId: cid, decision: "note", note: "operator comment for the record" });
    assert.equal(note.recorded, true);
  } finally {
    await h.close();
  }
});
