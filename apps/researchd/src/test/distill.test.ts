// distill.test.ts — agent-distillation: journal access, lesson validation
// (real eventIds accepted, fabricated rejected), knowledge write.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { ResearchCore, Scheduler, loadModules, verifiersForCampaign, validateLessonSources, type AgentLesson } from "@research-os/core";
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
  title: "distill-src", modules: ["mathematics"],
  objective: { statement: "x", questions: [], deliverables: [], successCriteria: [{ type: "claim_status", value: "verified" }], constraints: [], exclusions: [], assumptions: [], riskClass: "low" },
  models: { defaultPool: [] }, search: { policy: "round-robin", blindGenerators: 1, maxBranches: 2 },
  budgets: { maxAgentRuns: 5, maxTasks: 10, maxRounds: 1, maxExperiments: 5, wallClockMinutes: 30, maxTokensEstimate: 1e6 },
  autonomy: { level: "L3", humanApprovalRequiredFor: [] }, workers: { autoSpawn: 0, leaseSeconds: 60 },
  stop: { onSuccess: true, onBudgetExhausted: true, noProgressRounds: 2 }, verification: { requireIndependentAudit: true },
};

test("lesson with REAL eventIds accepted; FABRICATED ids rejected (anti-hallucination gate)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ros-distill-"));
  process.env.RESEARCH_HOME = home;
  const core = new ResearchCore(home);
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
  try {
    const created = await api("POST", "/v1/campaigns", { spec: SPEC });
    const cid = created.id;
    const proj = core.requireCampaign(cid);

    // seed the journal with real events
    core.apply(proj, "object.created", { kind: "worker", id: "w" }, {
      object: { id: "claim:cl_1", type: "claim", title: "test claim", content: {}, epistemicStatus: "unverified", tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    });
    const events = proj.store.readAll();
    const realEventId = events[events.length - 1].id;
    const realObjectId = "claim:cl_1";

    // journal route works
    const journal = await api("GET", `/v1/campaigns/${cid}/journal`);
    assert.ok(journal.total >= 2, "journal accessible");
    assert.ok(journal.events.some((e: { id: string }) => e.id === realEventId), "seeded event visible in journal");

    // VALID lesson (real event id)
    const good: AgentLesson = {
      kind: "lesson",
      problem: "zz-test",
      title: "The winning strategy was falsification-first",
      body: "The journal shows the falsification-first approach killed weak hypotheses before expensive verification ran.",
      sourceEventIds: [realEventId],
      sourceObjectIds: [realObjectId],
    };
    const ok = await api("POST", "/v1/knowledge/lesson", { sourceCampaignId: cid, lesson: good });
    assert.equal(ok.accepted, true, `valid lesson accepted: ${JSON.stringify(ok.validation)}`);
    assert.equal(ok.knowledgeObject.kind, "lesson");

    // FABRICATED lesson (invented event id)
    const bad: AgentLesson = {
      kind: "lesson",
      problem: "zz-test",
      title: "Hallucinated lesson about something that never happened",
      body: "This lesson cites an event id that does not exist in the journal — it should be rejected.",
      sourceEventIds: ["event:evt_99999"],
    };
    const rejected = await api("POST", "/v1/knowledge/lesson", { sourceCampaignId: cid, lesson: bad });
    assert.equal(rejected.accepted, false, "fabricated lesson rejected");
    assert.ok(rejected.validation.reasons.some((r: string) => r.includes("fabricated")), "rejection reason mentions fabrication");

    // NO SOURCES at all
    const noSrc: AgentLesson = {
      kind: "synthesis",
      problem: "zz-test",
      title: "Uncited synthesis",
      body: "This synthesis has no sourceEventIds — it must be rejected because uncited lessons are not knowledge.",
      sourceEventIds: [],
    };
    const rejected2 = await api("POST", "/v1/knowledge/lesson", { sourceCampaignId: cid, lesson: noSrc });
    assert.equal(rejected2.accepted, false, "uncited lesson rejected");
  } finally {
    delete process.env.RESEARCH_HOME;
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("validateLessonSources unit: pure logic", () => {
  const ids = new Set(["event:evt_1", "event:evt_2"]);
  const good = validateLessonSources({ kind: "lesson", problem: "p", title: "valid", body: "a body long enough to pass validation checks", sourceEventIds: ["event:evt_1"] }, ids);
  assert.equal(good.ok, true);
  const bad = validateLessonSources({ kind: "lesson", problem: "p", title: "bad", body: "a body long enough to pass validation checks", sourceEventIds: ["event:evt_1", "event:FAKE"] }, ids);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.missing, ["event:FAKE"]);
});
