// campaignService.ts — campaign lifecycle + workspace scaffolding (spec §3.1, §10.2).
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CampaignSpec } from "@research-os/contracts";
import { objectiveHash, type CampaignProjection, type ResearchCore } from "./core.js";
import { nowIso } from "./util.js";

export function createCampaign(
  core: ResearchCore,
  spec: CampaignSpec,
  opts: { piPackageDir: string; modules?: import("@research-os/contracts").LoadedModule[] },
): CampaignProjection {
  const proj = core.createCampaign(spec, opts);
  // merge domain-module guidance into the spec so it lives in the campaign.created
  // event (replay-safe) — core never interprets the content
  const modulePrompts: Record<string, string> = { ...(spec.modulePrompts ?? {}) };
  for (const m of opts.modules ?? []) {
    for (const [key, text] of Object.entries(m.manifest.prompts ?? {})) {
      modulePrompts[key] = modulePrompts[key] ? `${modulePrompts[key]}\n${text}` : String(text);
    }
  }
  const enrichedSpec = { ...spec, modulePrompts };
  scaffoldWorkspace(proj, opts.piPackageDir, enrichedSpec, opts.modules ?? []);
  const objective: import("@research-os/contracts").ObjectiveSpec = {
    id: `${proj.state.id}/o_1`,
    statement: spec.objective.statement,
    questions: spec.objective.questions,
    deliverables: spec.objective.deliverables,
    successCriteria: spec.objective.successCriteria,
    constraints: spec.objective.constraints,
    exclusions: spec.objective.exclusions,
    assumptions: spec.objective.assumptions,
    riskClass: spec.objective.riskClass,
    version: 1,
  };
  objective.contentHash = objectiveHash(objective);  core.apply(proj, "campaign.created", { kind: "human", id: "operator" }, { spec: { ...enrichedSpec, id: proj.state.id } });
  core.apply(proj, "objective.versioned", { kind: "human", id: "operator" }, { objective });
  return proj;
}

export function startCampaign(core: ResearchCore, proj: CampaignProjection): void {
  if (proj.state.status !== "created" && proj.state.status !== "paused") {
    throw new Error(`campaign is ${proj.state.status}`);
  }
  core.apply(proj, "campaign.started", { kind: "human", id: "operator" }, {});
}

export function pauseCampaign(core: ResearchCore, proj: CampaignProjection): void {
  core.apply(proj, "campaign.paused", { kind: "human", id: "operator" }, {});
}

export function resumeCampaign(core: ResearchCore, proj: CampaignProjection): void {
  core.apply(proj, "campaign.resumed", { kind: "human", id: "operator" }, {});
}

export function stopCampaign(core: ResearchCore, proj: CampaignProjection, reason: string): void {
  core.apply(proj, "campaign.stopped", { kind: "human", id: "operator" }, { reason });
}

/** Create the campaign workspace: state dirs + .pi extension/skills + AGENTS.md. */
export function scaffoldWorkspace(
  proj: CampaignProjection,
  piPackageDir: string,
  spec: CampaignSpec,
  modules: import("@research-os/contracts").LoadedModule[] = [],
): void {
  mkdirSync(path.join(proj.workspaceDir, "state", "artifacts"), { recursive: true });
  mkdirSync(path.join(proj.workspaceDir, "state", "sandbox"), { recursive: true });
  mkdirSync(path.join(proj.workspaceDir, "experiments"), { recursive: true });

  // .pi/ — extension + skills copied from the research-os-pi package so the workspace is self-contained
  const piDir = path.join(proj.workspaceDir, ".pi");
  if (existsSync(piPackageDir)) {
    cpSync(path.join(piPackageDir, "extension"), path.join(piDir, "extensions", "research-os"), { recursive: true });
    cpSync(path.join(piPackageDir, "skills"), path.join(piDir, "skills"), { recursive: true });
  } else {
    process.stderr.write(`[campaignService] pi package dir not found: ${piPackageDir} — workspace will lack research tools\n`);
  }
  // domain-module seed skills → worker context (auto-loaded by Pi)
  for (const m of modules) {
    if (!spec.modules?.includes(m.manifest.id)) continue;
    for (const skill of m.skills) {
      const dest = path.join(piDir, "skills", skill.name);
      if (!existsSync(dest)) cpSync(skill.path, dest, { recursive: true });
    }
  }

  // AGENTS.md — context file auto-loaded by pi (worker contract + pointers)
  writeFileSync(
    path.join(proj.workspaceDir, "AGENTS.md"),
    `# ResearchOS worker workspace — ${spec.title}

You are a ResearchOS research worker for campaign \`${proj.state.id}\`.

- Read the **research-worker** skill before your first task.
- Your \`research_*\` tools talk to the ResearchOS core (authoritative state).
- Durable results live in ResearchOS, NOT in this chat. Mesh messages are coordination only.
- Campaign objective is immutable for you. Success criteria: ${spec.objective.successCriteria.map((c) => c.type + ":" + c.value).join(", ")}.
- Model: single-pool deployment (ZAI GLM-5.3). Role diversity comes from tasks, not models.
`,
    "utf8",
  );
}

export function completedCriteria(proj: CampaignProjection): { type: string; value: string; evidenceRef?: string }[] {
  const out: { type: string; value: string; evidenceRef?: string }[] = [];
  for (const c of proj.state.objective.successCriteria) {
    if (c.type === "claim_status") {
      // satisfied by a claim that reached this status VIA a verification (invariant C)
      for (const v of proj.verifications.values()) {
        if (v.status === "pending" || v.status === "error") continue;
        const target = proj.objects.get(v.targetId);
        if (!target || !["claim", "hypothesis"].includes(target.type)) continue;
        if (target.epistemicStatus === c.value && v.appliedTransitions?.some((t) => t.to === c.value)) {
          out.push({ type: c.type, value: c.value, evidenceRef: v.id });
          break;
        }
      }
    } else if (c.type === "verified_object") {
      const hit = [...proj.objects.values()].find(
        (o) => o.type === c.value && o.epistemicStatus && ["verified", "falsified", "reproduced"].includes(o.epistemicStatus),
      );
      if (hit) out.push({ type: c.type, value: c.value, evidenceRef: hit.id });
    } else if (c.type === "artifact") {
      if (proj.artifacts.size > 0) out.push({ type: c.type, value: c.value });
    }
  }
  return out;
}

export function markCompleted(core: ResearchCore, proj: CampaignProjection, criteria: { type: string; value: string; evidenceRef?: string }[]): void {
  core.apply(proj, "campaign.completed", { kind: "scheduler", id: "researchd" }, {
    summary: `success criteria satisfied: ${criteria.map((c) => `${c.type}=${c.value}`).join(", ")}`,
    criteria,
    at: nowIso(),
  });
}
