// globalMemory.ts — workspace-global cross-campaign memory (V0.4).
// researchd keeps two append-only stores under the workspaces root:
//   global-memory.jsonl  (negative episodes, exportable)
//   global-skills.jsonl  (skill candidates/citations/activations mirror)
// The core subscribes and mirrors; ContextPack injection reads them via the
// accessor passed by the daemon. Pure functions here — no daemon dependency.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ContextItem, MemoryItem, ResearchSkill } from "@research-os/contracts";
import { relevance, tokenize, truncate } from "./util.js";

export interface GlobalMemoryEntry {
  hash: string;
  campaignId: string;
  kind: "negative" | "procedural";
  title: string;
  content: Record<string, unknown>;
  createdAt: string;
}

export interface GlobalSkillEntry {
  id: string;
  hash: string;
  campaignId: string;
  name: string;
  activation: string[];
  procedure: string[];
  state: "candidate" | "active";
  citations: number;
  createdAt: string;
}

export function memoryHash(m: Pick<MemoryItem, "title" | "content">): string {
  return `${m.title}::${JSON.stringify(m.content)}`.slice(0, 400);
}

export function loadMemoryStore(file: string): GlobalMemoryEntry[] {
  if (!existsSync(file)) return [];
  const out: GlobalMemoryEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as GlobalMemoryEntry);
    } catch {
      /* skip */
    }
  }
  return out;
}

export function loadSkillStore(file: string): GlobalSkillEntry[] {
  if (!existsSync(file)) return [];
  const out: GlobalSkillEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as GlobalSkillEntry);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Top-k global negative lessons relevant to a task (same-module preference via query text). */
export function relevantGlobalLessons(store: GlobalMemoryEntry[], query: string, k = 3): ContextItem[] {
  const qt = tokenize(query);
  return store
    .map((e) => ({
      item: { ref: `global:${e.hash.slice(0, 24)}`, title: `[${e.campaignId}] ${e.title}`, snippet: truncate(JSON.stringify(e.content), 240), epistemicStatus: "negative-lesson" } as ContextItem,
      score: relevance(qt, `${e.title} ${JSON.stringify(e.content)}`),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.item);
}

/** Top-k global skills (prefer active, then cited). */
export function relevantGlobalSkills(store: GlobalSkillEntry[], query: string, k = 2): ContextItem[] {
  const qt = tokenize(query);
  return store
    .map((e) => ({
      item: { ref: `global-skill:${e.name}`, title: `skill[${e.state}] (cited ${e.citations}x): ${e.name}`, snippet: truncate(e.procedure.join(" → "), 240) } as ContextItem,
      score: relevance(qt, `${e.name} ${e.activation.join(" ")} ${e.procedure.join(" ")}`) + (e.state === "active" ? 0.3 : 0) + Math.min(e.citations * 0.05, 0.2),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.item);
}

export const GLOBAL_MEMORY_FILE = "global-memory.jsonl";
export const GLOBAL_SKILLS_FILE = "global-skills.jsonl";
export function globalStorePaths(workspacesRoot: string): { memory: string; skills: string } {
  return { memory: path.join(workspacesRoot, GLOBAL_MEMORY_FILE), skills: path.join(workspacesRoot, GLOBAL_SKILLS_FILE) };
}
