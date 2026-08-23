// reportService.ts — reports generated from structured state, not model memory (spec §60).
import type { CampaignProjection } from "./core.js";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { humanDuration } from "./util.js";

export function buildReport(proj: CampaignProjection): string {
  const s = proj.state;
  const lines: string[] = [];
  const claims = [...proj.objects.values()].filter((o) => o.type === "claim" || o.type === "hypothesis");
  const byStatus = (st: string) => claims.filter((c) => c.epistemicStatus === st);

  lines.push(`# Research report — ${s.title}`);
  lines.push("");
  lines.push(`- campaign: \`${s.id}\`  status: **${s.status}**  rounds: ${s.currentRound}`);
  lines.push(`- objective (v${s.objective.version}): ${s.objective.statement}`);
  lines.push(`- success criteria: ${s.objective.successCriteria.map((c) => `${c.type}=${c.value}`).join("; ")}`);
  lines.push(
    `- budget: agent runs ${s.budgets.consumed.agentRuns}/${s.budgets.limits.maxAgentRuns}, tasks ${s.budgets.consumed.tasksCreated}/${s.budgets.limits.maxTasks}, experiments ${s.budgets.consumed.experiments}/${s.budgets.limits.maxExperiments}`,
  );
  if (s.budgets.consumed.startedAt) {
    lines.push(`- wall clock budget: ${humanDuration(Date.now() - Date.parse(s.budgets.consumed.startedAt))} / ${humanDuration(s.budgets.limits.wallClockMinutes * 60_000)}`);
  }
  lines.push("");

  lines.push(`## Objective hash`);
  lines.push("");
  lines.push("```");
  lines.push(s.objective.contentHash ?? "(none)");
  lines.push("```");
  lines.push("");

  lines.push(`## Verified findings`);
  lines.push("");
  const verified = [...byStatus("verified"), ...byStatus("reproduced")];
  if (verified.length === 0) lines.push("_none yet_");
  for (const c of verified) lines.push(`- **${c.title}** \`${c.id}\` — ${stringify(c.content.statement ?? c.content)}${domainLine(c)}`);
  lines.push("");

  lines.push(`## Falsified hypotheses`);
  lines.push("");
  const falsified = byStatus("falsified");
  if (falsified.length === 0) lines.push("_none yet_");
  for (const c of falsified) {
    const v = [...proj.verifications.values()].filter((x) => x.targetId === c.id && x.status !== "pending").pop();
    lines.push(`- **${c.title}** \`${c.id}\` — ${stringify(c.content.statement ?? c.content)}${c.content.flaggedBound ? " ⚠ BOUND OVERSTATED (see note)" : ""}${v ? ` (verifier ${v.verifierId} → ${v.status}, log \`${v.artifactRef}\`)` : ""}`);
  }
  lines.push("");

  lines.push(`## Strong but unverified findings`);
  lines.push("");
  const strong = [...byStatus("empirically_supported"), ...byStatus("source_supported")];
  if (strong.length === 0) lines.push("_none yet_");
  for (const c of strong) lines.push(`- ${c.title} \`${c.id}\` — ${stringify(c.content.statement ?? c.content)}`);
  lines.push("");

  lines.push(`## Speculative / unverified claims`);
  lines.push("");
  const spec = [...byStatus("speculative"), ...byStatus("unverified"), ...byStatus("inconclusive")];
  if (spec.length === 0) lines.push("_none_");
  for (const c of spec.slice(0, 15)) lines.push(`- ${c.title} \`${c.id}\` (${c.epistemicStatus})`);
  lines.push("");

  lines.push(`## Branches`);
  lines.push("");
  for (const b of [...proj.branches.values()].sort((x, y) => x.id.localeCompare(y.id))) {
    lines.push(`- \`${b.id}\` **${b.status}** — ${b.thesis}  (methods: ${b.methodTags.join(", ") || "-"}; accepted results: ${b.acceptedCount})`);
  }
  lines.push("");

  lines.push(`## Experiments and reproducibility`);
  lines.push("");
  const experiments = [...proj.objects.values()].filter((o) => o.type === "experiment" || o.type === "experiment_result");
  if (experiments.length === 0) lines.push("_none_");
  for (const e of experiments) lines.push(`- ${e.title} \`${e.id}\` — ${stringify(e.content, 200)}`);
  const verifications = [...proj.verifications.values()].filter((v) => v.status !== "pending");
  if (verifications.length > 0) {
    lines.push("");
    lines.push(`Verifications: ${verifications.length} (${verifications.filter((v) => v.status === "passed").length} passed / ${verifications.filter((v) => v.status === "failed").length} failed)`);
    for (const v of verifications) lines.push(`- \`${v.id}\` ${v.verifierId} on ${v.targetId} → **${v.status}** (log artifact \`${v.artifactRef}\`)`);
  }
  lines.push("");

  lines.push(`## Negative results memory`);
  lines.push("");
  const failures = [...proj.memories.values()].filter((m) => m.kind === "negative");
  if (failures.length === 0) lines.push("_none_");
  for (const f of failures.slice(0, 20)) lines.push(`- ${f.title} \`${f.id}\``);
  lines.push("");

  lines.push(`## Research skills learned (candidates unless noted)`);
  lines.push("");
  if (proj.skills.size === 0) lines.push("_none_");
  for (const sk of proj.skills.values()) {
    lines.push(`- **${sk.name}** [${sk.verificationState}] \`${sk.id}\` — activate when: ${sk.activation.join("; ")}`);
    for (const step of sk.procedure) lines.push(`  - ${step}`);
  }
  lines.push("");

  lines.push(`## Remaining uncertainty / open questions`);
  lines.push("");
  const questions = [...proj.objects.values()].filter((o) => o.type === "question");
  if (questions.length === 0) lines.push("_none recorded_");
  for (const q of questions.slice(0, 15)) lines.push(`- ${q.title} \`${q.id}\``);
  lines.push("");

  lines.push(`## Artifacts`);
  lines.push("");
  if (proj.artifacts.size === 0) lines.push("_none_");
  for (const a of proj.artifacts.values()) lines.push(`- \`${a.id}\` ${a.logicalName} (sha256 ${a.sha256.slice(0, 12)}…, ${a.size}B, by ${a.producer})`);
  lines.push("");

  return lines.join("\n");
}

/** Persist report under campaign state/reports and return path. */
export function saveReport(proj: CampaignProjection, report: string): string {
  const dir = path.join(proj.stateDir, "reports");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `report-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  writeFileSync(file, report, "utf8");
  return file;
}

function domainLine(c: { content: Record<string, unknown> }): string {
  const d = c.content.verifiedDomain as { mode?: string; realCoverage?: { min: number; max: number }[]; variables?: { min: number; max: number }[]; testedCases?: number } | undefined;
  if (!d) return "";
  const cov = d.realCoverage ?? d.variables ?? [];
  if (cov.length === 0) return d.mode === "symbolic" ? " (symbolic — exact)" : "";
  const [lo, hi] = [Math.min(...cov.map((r) => r.min)), Math.max(...cov.map((r) => r.max))];
  const cases = d.testedCases ? `, ${d.testedCases.toLocaleString("en-US")} cases` : "";
  const flag = c.content.flaggedBound ? " ⚠ ANNOUNCED BOUND EXCEEDS VERIFIED DOMAIN" : "";
  return ` — verified on [${lo}, ${hi}] (${d.mode}${cases})${flag}`;
}

function stringify(v: unknown, max = 300): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
