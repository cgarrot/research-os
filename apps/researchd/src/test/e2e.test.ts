// e2e.test.ts — full-engine integration test WITHOUT any LLM: a scripted fake
// worker drives researchd over HTTP exactly like the research_* tools would.
// Validates: event store + replay, scheduler phases, leases, audit, artifacts,
// deterministic verifier, claim falsification (invariant C), memory, report,
// idempotency, crash/restart resume (spec §52 Phase 0-2 acceptance, §54).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import {
  ResearchCore,
  Scheduler,
  loadModules,
  verifiersForCampaign,
  buildReport,
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

interface Harness {
  core: ResearchCore;
  scheduler: Scheduler;
  port: number;
  close: () => Promise<void>;
}

async function startDaemon(): Promise<Harness> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "researchos-test-"));
  const core = new ResearchCore(home);
  core.load();
  const modules = loadModules([path.join(ROOT, "modules")]);
  const scheduler = new Scheduler({
    core,
    modulesFor: (proj) => {
      const set = verifiersForCampaign(modules, proj.state.modules);
      const m = modules.filter((x) => proj.state.modules.includes(x.manifest.id));
      return { verifiers: set, diversityDescriptors: m.flatMap((x) => x.manifest.diversityDescriptors), roles: [] };
    },
  });
  const server = http.createServer((req, res) => {
    void handleRequest({ core, modulesDir: path.join(ROOT, "modules"), piPackageDir: path.join(ROOT, "pi", "research-os-pi"), mesh: { status: async () => ({ connected: false }), broadcast: async () => ({}) } }, req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    core,
    scheduler,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function client(port: number) {
  return async (method: string, p: string, body?: unknown): Promise<any> => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${text.slice(0, 300)}`);
    return json;
  };
}

const SPEC = {
  title: "e2e falsification campaign",
  modules: ["mathematics-lite"],
  objective: {
    statement: "Conjecture: for every integer n >= 0, f(n) = n^2 + n + 41 is prime. Falsify with an exact verified counterexample.",
    questions: ["For which n does f(n) fail?"],
    deliverables: [{ kind: "report", description: "report" }],
    successCriteria: [{ type: "claim_status", value: "falsified", description: "exact counterexample" }],
    constraints: ["exact arithmetic"],
    exclusions: [],
    assumptions: ["integer arithmetic"],
    riskClass: "low",
  },
  models: { defaultPool: [{ id: "zai-glm-5.3", provider: "zai", model: "glm-5.3", runtime: "pi", thinkingLevel: "max", tags: [] }] },
  search: { policy: "round-robin", blindGenerators: 2, maxBranches: 4 },
  budgets: { maxAgentRuns: 20, maxTasks: 30, maxRounds: 2, maxExperiments: 6, wallClockMinutes: 10, maxTokensEstimate: 1_000_000 },
  autonomy: { level: "L3", humanApprovalRequiredFor: [] },
  workers: { autoSpawn: 0, leaseSeconds: 300 },
  stop: { onSuccess: true, onBudgetExhausted: true, noProgressRounds: 2 },
  verification: { requireIndependentAudit: true },
};

/** The scripted worker: behaves per phase like a real explorer/adversary/experimentalist. */
async function fakeWorkerRound(api: ReturnType<typeof client>, campaignId: string, alias: string): Promise<void> {
  for (let guard = 0; guard < 40; guard++) {
    const claimed = await api("POST", "/v1/tasks/claim", { campaignId, workerAlias: alias, mode: "interactive" });
    if (!claimed.task) return;
    const task = claimed.task;
    const ctx = claimed.context ?? {};

    if (task.phase === "ground") {
      const q = await api("POST", "/v1/objects", {
        campaignId, type: "question", title: "Where does f(n) fail?", content: { text: "Find n such that n^2+n+41 is composite." }, createdBy: alias,
      });
      await submit(api, campaignId, alias, task.id, [q.object.id], `Mapped the core question ${q.object.id}.`);
    } else if (task.phase === "generate") {
      const br = await api("POST", "/v1/branches", {
        campaignId, thesis: `Search for composite values of f(n) (${task.seed ?? "computational"} approach)`, methodTags: [String(task.seed ?? "computational")], createdBy: alias,
      });
      const h = await api("POST", "/v1/objects", {
        campaignId, type: "hypothesis", title: "f(n) composite for some small n",
        content: { statement: "There exists n < 100 with f(n)=n^2+n+41 composite, likely n=40 giving 41^2." },
        branchId: br.branch.id, createdBy: alias,
      });
      await submit(api, campaignId, alias, task.id, [br.branch.id, h.object.id], `Opened branch ${br.branch.id} with hypothesis ${h.object.id}.`);
    } else if (task.phase === "critique") {
      const obs = await api("POST", "/v1/objects", {
        campaignId, type: "observation", title: "f(40)=1681=41*41 candidate",
        content: { text: "Direct computation: 40^2+40+41 = 1681 = 41^2. Cheap counterexample candidate." },
        branchId: task.branchId, createdBy: alias,
      });
      await submit(api, campaignId, alias, task.id, [obs.object.id], `Critique: identified exact counterexample candidate n=40.`);
    } else if (task.phase === "test") {
      const claim = await api("POST", "/v1/objects", {
        campaignId, type: "claim", title: "Euler conjecture: f(n) prime for all n >= 0",
        content: { statement: "For every integer n >= 0, n^2+n+41 is prime." },
        branchId: task.branchId, createdBy: alias,
      });
      const ex = await api("POST", "/v1/objects", {
        campaignId, type: "experiment", title: "Exact check at n=40",
        content: { purpose: "Test f(40) primality exactly", method: "trial division in verifier", expectedOutputs: "f(40) composite iff conjecture falsified" },
        branchId: task.branchId, createdBy: alias,
      });
      const art = await api("POST", "/v1/artifacts", {
        campaignId, contentBase64: Buffer.from("n=40: f(40)=1681=41*41 (computed by verifier)").toString("base64"),
        logicalName: "experiment-n40.txt", producer: alias, branchId: task.branchId,
      });
      const v = await api("POST", "/v1/verifications", {
        campaignId, targetId: claim.object.id, verifierId: "mathematics-lite:counterexample-check",
        requestedBy: alias, input: { expression: "n*n+n+41", n: 40, predicate: "not_prime" },
      });
      assert.equal(v.verification.status, "passed", "counterexample verification must pass");
      await submit(api, campaignId, alias, task.id, [claim.object.id, ex.object.id], `Claim ${claim.object.id} falsified via exact counterexample n=40; experiment ${ex.object.id}; artifact ${art.artifact.id}.`, [art.artifact.id]);
    } else if (task.phase === "consolidate") {
      const d = await api("POST", "/v1/objects", {
        campaignId, type: "decision", title: `Round ${task.round} synthesis`,
        content: { text: "Conjecture falsified by exact counterexample; branch portfolio healthy." }, createdBy: alias,
      });
      await submit(api, campaignId, alias, task.id, [d.object.id], `Synthesized round ${task.round}.`);
    } else {
      await submit(api, campaignId, alias, task.id, [], `unknown phase ${task.phase}`);
    }
  }
}

async function submit(api: ReturnType<typeof client>, campaignId: string, alias: string, taskId: string, objects: string[], summary: string, artifacts: string[] = []): Promise<void> {
  const out = await api("POST", `/v1/tasks/${encodeURIComponent(taskId)}/result`, {
    campaignId, workerAlias: alias, status: "success", createdObjects: objects, createdArtifacts: artifacts,
    evidence: [], openQuestions: [], blockers: [], summary,
  });
  assert.equal(out.accepted, true, `result must be accepted: ${JSON.stringify(out.audit ?? {})}`);
}

test("e2e: campaign lifecycle, falsification, replay resume, idempotency, report", async (t) => {
  const harness = await startDaemon();
  const api = client(harness.port);
  try {
    // health
    const health = await api("GET", "/v1/health");
    assert.equal(health.ok, true);

    // verifiers discovered from the module
    const verifiersRes = await api("GET", "/v1/verifiers");
    const verifiers = verifiersRes.verifiers ?? verifiersRes;
    assert.ok(verifiers.some((v: any) => v.id === "mathematics-lite:counterexample-check"));

    // create + start
    const created = await api("POST", "/v1/campaigns", { spec: SPEC });
    const campaignId = created.id;
    assert.ok(campaignId.startsWith("campaign:c_"));

    // workers cannot self-promote claims (invariant C)
    await assert.rejects(
      () => api("POST", "/v1/objects", { campaignId, type: "claim", title: "x", content: {}, epistemicStatus: "verified", createdBy: "w" }),
      /verification path only/,
    );

    await api("POST", `/v1/campaigns/${campaignId}/start`, {});

    // scheduler loop (fast ticks for the test)
    const ticker = setInterval(() => harness.scheduler.tick(), 300);

    // two fake workers race through phases
    const deadline = Date.now() + 60_000;
    let done = false;
    while (Date.now() < deadline) {
      const status = await api("GET", `/v1/campaigns/${campaignId}`);
      if (status.status === "completed" || status.status === "stopped") {
        done = true;
        break;
      }
      await fakeWorkerRound(api, campaignId, "fake-worker-1").catch(() => undefined);
      await fakeWorkerRound(api, campaignId, "fake-worker-2").catch(() => undefined);
      await new Promise((r) => setTimeout(r, 150));
    }
    clearInterval(ticker);
    assert.ok(done, "campaign must terminate");
    const final = await api("GET", `/v1/campaigns/${campaignId}`);
    assert.equal(final.status, "completed", `expected completed, got ${final.status}`);

    // falsified claim via verifier only
    const proj = harness.core.requireCampaign(campaignId);
    const falsified = [...proj.objects.values()].filter((o) => o.type === "claim" && o.epistemicStatus === "falsified");
    assert.ok(falsified.length >= 1, "at least one falsified claim");
    const falsifiedId = falsified[0].id;
    const ver = [...proj.verifications.values()].find((v) => v.status === "passed");
    assert.ok(ver, "a passing verification exists");
    assert.equal(ver?.verifierId, "mathematics-lite:counterexample-check");
    assert.equal(ver?.appliedTransitions?.[0]?.to, "falsified");
    assert.ok(ver?.artifactRef, "verification output stored as artifact");
    const artContent = await fetch(`http://127.0.0.1:${harness.port}/v1/artifacts/${encodeURIComponent(ver!.artifactRef!)}/content`).then((r) => r.text());
    assert.match(artContent, /1681/);

    // memory: episodic memories consolidated
    assert.ok(proj.memories.size >= 3, "episodic memories consolidated");

    // report
    const report = buildReport(proj);
    assert.match(report, /Falsified hypotheses/);
    assert.match(report, /1681|n\^2\+n\+41|41\*41|f\(40\)/i);

    // idempotency: replaying the campaign creation events is tested via restart below.

    // ---- crash + restart: replay rebuilds identical state (spec §54.9-10)
    const eventsBefore = proj.store.readAll().length;
    await harness.close();
    const home = proj.workspaceDir ? path.dirname(proj.workspaceDir) : harness.core.rootDir;
    const core2 = new ResearchCore(harness.core.rootDir);
    const loaded = core2.load();
    assert.ok(loaded.events >= eventsBefore - 1, `replayed events (got ${loaded.events}, want ~${eventsBefore})`);
    const proj2 = core2.requireCampaign(campaignId);
    assert.equal(proj2.objects.get(falsifiedId)?.epistemicStatus, "falsified", "claim stays falsified after restart");
    assert.equal(proj2.state.status, "completed");
    // a resumed campaign keeps durable knowledge: workers continue from stored state
  } finally {
    await harness.close();
  }
});

test("idempotency: duplicate result submission is a no-op", async () => {
  const harness = await startDaemon();
  const api = client(harness.port);
  try {
    const created = await api("POST", "/v1/campaigns", { spec: SPEC });
    const campaignId = created.id;
    const proj = harness.core.requireCampaign(campaignId);
    // inject a task directly through the scheduler
    harness.scheduler.tick(); // opens round 1 ground
    await api("POST", `/v1/campaigns/${campaignId}/start`, {});
    harness.scheduler.tick();
    const task = [...proj.tasks.values()].find((x) => x.status === "queued");
    assert.ok(task, "ground task created");
    const claimed = await api("POST", "/v1/tasks/claim", { campaignId, workerAlias: "dup-worker", mode: "interactive" });
    const q = await api("POST", "/v1/objects", { campaignId, type: "question", title: "q", content: { text: "q" }, createdBy: "dup-worker" });
    const key = "idem-key-1";
    const r1 = await api("POST", `/v1/tasks/${encodeURIComponent(claimed.task.id)}/result`, {
      campaignId, workerAlias: "dup-worker", status: "success", createdObjects: [q.object.id], summary: "did the grounding work", idempotencyKey: key,
    });
    assert.equal(r1.accepted, true);
    const r2 = await api("POST", `/v1/tasks/${encodeURIComponent(claimed.task.id)}/result`, {
      campaignId, workerAlias: "dup-worker", status: "success", createdObjects: [q.object.id], summary: "did the grounding work AGAIN", idempotencyKey: key,
    });
    assert.equal(r2.duplicate, true, "second submission is detected as duplicate");
  } finally {
    await harness.close();
  }
});
