#!/usr/bin/env node
// generate-campaigns.mjs — render numbered campaign YAMLs from catalog.json.
// Idempotent: overwrites only files whose slug comes from the catalog (numbered);
// never touches hand-written 01-06 files. Re-run after editing the catalog.
//
//   node bin/generate-open-problem-campaigns.mjs [--check]   (--check: diff only, exit 1 on drift)
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "examples", "open-problems");
const catalog = JSON.parse(readFileSync(path.join(DIR, "catalog.json"), "utf8"));
const CHECK = process.argv.includes("--check");

const q = (s) => JSON.stringify(String(s));
const list = (arr) => arr.map((x) => `      - ${q(x)}`).join("\n");

const MODES = {
  bounded: { criteria: ["verified", "falsified"], stopOnSuccess: true },
  aux: { criteria: ["verified", "falsified"], stopOnSuccess: true },
  search: { criteria: ["verified", "falsified"], stopOnSuccess: false },
  exploration: { criteria: ["falsified"], stopOnSuccess: true },
  "frontier-record": { criteria: ["verified", "falsified"], stopOnSuccess: true },
  "new-object": { criteria: ["verified", "falsified"], stopOnSuccess: true },
};

const DISCOVERY_PROMPT = (mode) =>
  `DISCOVERY MODE (${mode}): follow the frontier-first / certificate-hunting / novelty-audit skills IN ORDER. ` +
  "Frontier snapshot BEFORE hunting (research_frontier_snapshot, dated sources); long searches as research_job_create jobs " +
  "(hunt.py, checkpoints, portfolios — never hours of compute inside your turns); candidates quarantined via " +
  "research_discovery_candidate; promotion only through research_candidate_promote (terminal = human review). " +
  "Novelty is decided by the adversarial novelty audit, never by the claimant.";

function render(p) {
  const prof = catalog.profiles[p.profile];
  const mode = MODES[p.mode];
  const criteria = mode.criteria
    .map((c) => `      - type: claim_status\n        value: ${c}\n        description: ${q(c === "verified" ? "at least one exactly-verified claim/certificate (verifier-run)" : "at least one auxiliary conjecture falsified by an exact counterexample")}`)
    .join("\n");
  const discovery = p.mode === "frontier-record" || p.mode === "new-object";
  return `campaign:
  title: ${q(p.title)}
  modules: [mathematics]
  objective:
    statement: ${q(`Open problem (Wikipedia FR, ${p.domain}): ${p.statement} Goal: OPERATIONAL progress under our epistemic rules — ${p.focus}`)}
    questions:
${list(p.questions)}
    deliverables:
      - kind: report
        description: "Evidence-backed report: verified/witness results, falsified auxiliaries, empirical support clearly labeled, discovery candidates + novelty statuses"
    successCriteria:
${criteria}
    constraints:
      - "exact integer arithmetic only (floats are exploration, never evidence)"
      - "never claim more than what was verified: state bounds honestly"
      - "known literature results are source-backed claims, not campaign-verified"
      - "records: NO hand-written frontier numbers — dated frontier snapshots only"
    exclusions:
      - "no unbounded claims from computation"
    assumptions:
      - "standard mathematical definitions"
    riskClass: low
  models:
    defaultPool:
      - id: zai-glm-5.3
        provider: zai
        model: glm-5.3
        runtime: pi
        thinkingLevel: max
        tags: [default]
  search:
    policy: round-robin
    blindGenerators: 3
    maxBranches: 8
  budgets:
    maxAgentRuns: ${prof.maxAgentRuns}
    maxTasks: ${prof.maxTasks}
    maxRounds: ${prof.maxRounds}
    maxExperiments: ${prof.maxExperiments}
    wallClockMinutes: ${prof.wallClockMinutes}
    maxTokensEstimate: 50000000
  autonomy: { level: L3, humanApprovalRequiredFor: [] }
  workers: { autoSpawn: 2, leaseSeconds: 3600, maxRunMinutes: ${Math.min(prof.wallClockMinutes, 360)} }
  stop: { onSuccess: ${mode.stopOnSuccess ? "true" : "false"}, onBudgetExhausted: true, noProgressRounds: 3, successSemantics: "all", minRounds: 2, requireCycle: true }${discovery ? `\n  modulePrompts:\n    worker: ${q(DISCOVERY_PROMPT(p.mode))}` : ""}
  verification: { requireIndependentAudit: true }
`;
}

let drift = 0;
for (const p of catalog.problems) {
  const file = path.join(DIR, `${p.slug}.yaml`);
  if (!/^[0-9]{2}[a-z]?-/.test(p.slug)) throw new Error(`catalog slug must be numbered: ${p.slug}`);
  const content = render(p);
  if (CHECK) {
    if (!existsSync(file) || readFileSync(file, "utf8") !== content) {
      console.error(`drift: ${p.slug}.yaml`);
      drift++;
    }
  } else {
    writeFileSync(file, content, "utf8");
    console.log(`wrote ${p.slug}.yaml`);
  }
}
const catalogSlugs = new Set(catalog.problems.map((p) => `${p.slug}.yaml`));
const keep = new Set([
  ...catalogSlugs,
  "01-collatz-syracuse.yaml", "02-goldbach.yaml", "03-legendre.yaml",
  "04-brocard.yaml", "05-gilbreath.yaml", "06-odd-perfect.yaml",
]);
for (const f of readdirSync(DIR)) {
  if (f.endsWith(".yaml") && !keep.has(f)) console.warn(`orphan (not in catalog, kept): ${f}`);
}
if (CHECK && drift > 0) process.exit(1);
console.log(CHECK ? "check clean" : `done: ${catalog.problems.length} campaigns`);
