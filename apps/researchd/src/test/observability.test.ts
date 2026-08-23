// observability.test.ts — V0.7: token usage parsing, frontier endpoint, budgets.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { ResearchCore, Scheduler, loadModules, verifiersForCampaign, parseUsageTokens } from "@research-os/core";
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

test("V0.7.1: parseUsageTokens reads the LAST usage event; fallback flagged", () => {
  const ndjson = [
    JSON.stringify({ type: "message_update", usage: { input: 10, output: 5 } }),
    JSON.stringify({ type: "message_end", usage: { input: 1200, output: 340 } }),
  ].join("\n");
  const got = parseUsageTokens(ndjson);
  assert.equal(got.total, 1540);
  assert.equal(got.estimated, false);
  const none = parseUsageTokens("no usage here at all");
  assert.equal(none.estimated, true);
  assert.ok(none.total > 0);
});

test("V0.7.2: frontier endpoint exposes verified/falsified/queued/budgets", async () => {
  const core = new ResearchCore(fs.mkdtempSync(path.join(os.tmpdir(), "ros-obs-")));
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
      title: "obs", modules: ["mathematics"],
      objective: { statement: "x", questions: [], deliverables: [], successCriteria: [{ type: "claim_status", value: "verified" }], constraints: [], exclusions: [], assumptions: [], riskClass: "low" },
      models: { defaultPool: [] }, search: { policy: "round-robin", blindGenerators: 1, maxBranches: 2 },
      budgets: { maxAgentRuns: 10, maxTasks: 10, maxRounds: 1, maxExperiments: 5, wallClockMinutes: 10, maxTokensEstimate: 1e6 },
      autonomy: { level: "L3", humanApprovalRequiredFor: [] }, workers: { autoSpawn: 0, leaseSeconds: 60 },
      stop: { onSuccess: true, onBudgetExhausted: true, noProgressRounds: 2 }, verification: { requireIndependentAudit: true },
    } });
    await api("POST", `/v1/campaigns/${created.id}/start`, {});
    scheduler.tick();
    const fr = await api("GET", `/v1/campaigns/${created.id}/frontier`);
    assert.equal(fr.campaignId, created.id);
    assert.ok(Array.isArray(fr.verifiedLemmas));
    assert.ok(fr.queuedByRole && typeof fr.queuedByRole === "object");
    assert.ok(fr.budgets && fr.budgets.consumed);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
