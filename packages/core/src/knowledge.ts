// knowledge.ts — cross-campaign knowledge base (v0.3 consolidation).
// Done campaigns are CONSOLIDATED into workspaces/knowledge/: their verified
// bounds, falsified claims, active skills, dead-ends and stats become objects
// that future campaigns consume as priorRuns. Never a source of truth by
// itself — every object carries provenance back to the originating event.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import type { ResearchEvent } from "@research-os/contracts";
import { tokenize, relevance } from "./util.js";

export interface KnowledgeObject {
  id: string; // ko_<hash8>
  kind: "claim" | "frontier-reached" | "skill" | "dead-end" | "stat" | "conjecture" | "lesson" | "generalized-skill" | "cross-link" | "synthesis";
  problem: string; // campaign file slug (e.g. "01-collatz-syracuse") or "(unknown)"
  statement: string;
  status?: string; // epistemic status for claims
  bound?: { variable: string; min: number; max: number };
  how?: string; // verifier / method summary
  provenance: { campaignId: string; objectId?: string; eventId?: string; extractedAt: string };
  text: string; // searchable blob
}

export interface KnowledgeIndexEntry {
  problem: string;
  runs: string[]; // campaignIds
  lastConsolidated: string;
  bounds: { variable: string; min: number; max: number; how: string }[];
  verifiedClaims: number;
  falsifiedClaims: number;
  deadEnds: number;
  skills: string[];
  searchBlob: string; // per-problem tokenizable summary
}

export interface KnowledgeIndex {
  version: 1;
  entries: Record<string, KnowledgeIndexEntry>;
}

export interface KnowledgeStore {
  dir: string;
  objectsFile: string;
  edgesFile: string;
  indexFile: string;
  reportsDir: string;
}

export function openKnowledge(workspacesRoot: string): KnowledgeStore {
  const dir = path.join(workspacesRoot, "knowledge");
  mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(dir, "reports"), { recursive: true });
  return {
    dir,
    objectsFile: path.join(dir, "objects.jsonl"),
    edgesFile: path.join(dir, "edges.jsonl"),
    indexFile: path.join(dir, "index.json"),
    reportsDir: path.join(dir, "reports"),
  };
}

function hash8(s: string): string {
  // tiny stable hash (not crypto — dedup key only)
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function loadObjects(store: KnowledgeStore): Map<string, KnowledgeObject> {
  const map = new Map<string, KnowledgeObject>();
  if (!existsSync(store.objectsFile)) return map;
  for (const line of readFileSync(store.objectsFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as KnowledgeObject;
      map.set(o.id, o);
    } catch {
      /* skip */
    }
  }
  return map;
}

function loadIndex(store: KnowledgeStore): KnowledgeIndex {
  if (existsSync(store.indexFile)) {
    try {
      return JSON.parse(readFileSync(store.indexFile, "utf8")) as KnowledgeIndex;
    } catch {
      /* rebuild */
    }
  }
  return { version: 1, entries: {} };
}

/** Extract knowledge objects from one campaign's events. Pure: no store writes. */
export function extractKnowledge(events: ResearchEvent[], problem: string): { objects: KnowledgeObject[]; edges: { source: string; target: string; relation: string }[] } {
  const objects: KnowledgeObject[] = [];
  const edges: { source: string; target: string; relation: string }[] = [];
  const now = new Date().toISOString();
  const claims = new Map<string, { title: string; status?: string; content: Record<string, unknown> }>();
  const skills = new Map<string, { name: string; procedure: string[]; state: string; citations: number }>();
  const memories = new Map<string, { title: string; kind: string; content: Record<string, unknown> }>();

  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    if (e.type === "object.created") {
      const o = p.object as { id?: string; type?: string; title?: string; content?: Record<string, unknown>; epistemicStatus?: string } | undefined;
      if (o?.type === "claim" || o?.type === "hypothesis") {
        claims.set(String(o.id), { title: String(o.title ?? ""), status: o.epistemicStatus, content: o.content ?? {} });
      }
      if (o?.type === "skill_object" && o.content) {
        skills.set(String(o.id), {
          name: String(o.content.name ?? "skill"),
          procedure: Array.isArray(o.content.procedure) ? (o.content.procedure as string[]) : [],
          state: String(o.content.verificationState ?? "candidate"),
          citations: Number(o.content.citations ?? 0),
        });
      }
    }
    if (e.type === "memory.skill_candidate_created") {
      const s = p.skill as { name?: string; procedure?: string[]; verificationState?: string; citations?: number; id?: string } | undefined;
      if (s?.name) {
        skills.set(String(s.id ?? s.name), { name: s.name, procedure: s.procedure ?? [], state: s.verificationState ?? "candidate", citations: s.citations ?? 0 });
      }
    }
    if (e.type === "memory.episode_created") {
      const m = p.memory as { id?: string; kind?: string; title?: string; content?: Record<string, unknown> } | undefined;
      if (m) memories.set(String(m.id), { title: String(m.title ?? ""), kind: String(m.kind ?? "episodic"), content: m.content ?? {} });
    }
    if (e.type === "claim.status_changed") {
      const c = claims.get(String(p.objectId));
      if (c) c.status = String(p.to);
    }
  }

  const cid = events[0]?.campaignId ?? "(unknown)";
  for (const [id, c] of claims) {
    if (c.status === "verified" || c.status === "falsified" || c.status === "empirically_supported") {
      // bound extraction: verifiedDomain realCoverage or explicit bound in content
      const dom = c.content.verifiedDomain as { realCoverage?: { variable: string; min: number; max: number }[]; variables?: { name: string; min: number; max: number }[] } | undefined;
      const covRaw = dom?.realCoverage ?? dom?.variables ?? [];
      const cov = covRaw.map((c) => ({ variable: String((c as { variable?: string; name?: string }).variable ?? (c as { name?: string }).name ?? "n"), min: Number(c.min), max: Number(c.max) }));
      let bound = cov && cov.length > 0 ? { variable: cov[0].variable, min: cov[0].min, max: cov[0].max } : undefined;
      if (!bound && c.status === "verified") {
        // fallback for pre-V0.2 claims: parse "…[a, b]…" / "below N" / "≤ 10^k" from the title
        // normalize: superscripts -> ^, keep commas for thousands inside brackets, unify "10^k"
        const sup: Record<string, string> = { "\u00b2": "2", "\u00b3": "3", "\u2074": "4", "\u2075": "5", "\u2076": "6" };
        const t2 = c.title.replace(/[\u00b2\u00b3\u2074\u2075\u2076]/g, (m) => "^" + (sup[m] ?? ""));
        const mRange = /\[\s*(\d[\d,]*)\s*,\s*([\d,.]+\s*(?:e\d+|\u00d7\s*10\^?\s*\d+)?)\s*\]/.exec(t2);
        const mBelow = /(?:below|up to|\u2264|\ble\b)\s*([\d,.]+(?:e\d+)?)\s*(?:\u00d7\s*10\^(\d+))?/i.exec(t2);
        const mPow = /10\s*\^\s*(\d+)/.exec(t2);
        const mPlain = /(?:all|every)[^\d]{0,20}(\d[\d,]{5,})/.exec(t2);
        let max = 0;
        if (mRange) {
          const raw = mRange[2].replace(/[\s,]/g, "").replace(/\u00d710\^?(\d+)/, (_m, d) => "e" + d);
          max = Number(raw) || 0;
        }
        if (!max && mBelow) {
          const raw = mBelow[1].replace(/[\s,]/g, "");
          max = Number(raw) * (mBelow[2] ? 10 ** Number(mBelow[2]) : 1);
        }
        if (!max && mPow) max = 10 ** Number(mPow[1]);
        if (!max && mPlain) max = Number(mPlain[1].replace(/,/g, ""));
        if (max >= 100) bound = { variable: "n", min: 0, max };
      }
      objects.push({
        id: `ko_${hash8(`${problem}|${id}|${c.title}`)}`,
        kind: "claim",
        problem,
        statement: c.title,
        status: c.status,
        bound,
        how: c.content.verifiedAt ? `verifier-run (see ${JSON.stringify(c.content.verifiedAt).slice(0, 120)})` : undefined,
        provenance: { campaignId: cid, objectId: id, extractedAt: now },
        text: `${c.title} ${c.status} ${bound ? `bound [${bound.min},${bound.max}]` : ""}`,
      });
    }
  }
  for (const [, s] of skills) {
    if (s.state === "active" || s.citations >= 1) {
      objects.push({
        id: `ko_${hash8(`skill|${problem}|${s.name}`)}`,
        kind: "skill",
        problem,
        statement: s.name,
        how: s.procedure.slice(0, 2).join(" → "),
        provenance: { campaignId: cid, extractedAt: now },
        text: `skill ${s.name} (${s.state}, ${s.citations} citations) ${s.procedure.join(" ")}`,
      });
    }
  }
  for (const [id, m] of memories) {
    if (m.kind === "negative") {
      objects.push({
        id: `ko_${hash8(`dead|${problem}|${id}|${m.title.slice(0, 60)}`)}`,
        kind: "dead-end",
        problem,
        statement: m.title,
        how: JSON.stringify(m.content).slice(0, 200),
        provenance: { campaignId: cid, objectId: id, extractedAt: now },
        text: m.title,
      });
    }
  }
  return { objects, edges };
}

/** Consolidate one campaign into the store. Idempotent by object id. Returns stats. */
export function consolidate(store: KnowledgeStore, events: ResearchEvent[], problem: string): { added: number; skipped: number; report: string } {
  const existing = loadObjects(store);
  const { objects } = extractKnowledge(events, problem);
  let added = 0;
  let skipped = 0;
  const newIds: string[] = [];
  for (const o of objects) {
    if (existing.has(o.id)) {
      skipped++;
      continue;
    }
    existing.set(o.id, o);
    appendFileSync(store.objectsFile, JSON.stringify(o) + "\n", "utf8");
    newIds.push(o.id);
    added++;
  }

  // rebuild index
  const index = loadIndex(store);
  const entry = index.entries[problem] ?? { problem, runs: [], lastConsolidated: "", bounds: [], verifiedClaims: 0, falsifiedClaims: 0, deadEnds: 0, skills: [], searchBlob: "" };
  entry.runs = [...new Set([...entry.runs, events[0]?.campaignId ?? "(unknown)"])];
  entry.lastConsolidated = new Date().toISOString();
  const all = [...existing.values()].filter((o) => o.problem === problem);
  entry.verifiedClaims = all.filter((o) => o.kind === "claim" && o.status === "verified").length;
  entry.falsifiedClaims = all.filter((o) => o.kind === "claim" && o.status === "falsified").length;
  entry.deadEnds = all.filter((o) => o.kind === "dead-end").length;
  entry.skills = all.filter((o) => o.kind === "skill").map((o) => o.statement);
  entry.bounds = all.filter((o) => o.kind === "claim" && o.bound && o.status === "verified").map((o) => ({ variable: o.bound!.variable, min: o.bound!.min, max: o.bound!.max, how: o.statement.slice(0, 80) }));
  entry.searchBlob = all.map((o) => o.text).join(" ").slice(0, 20000);
  index.entries[problem] = entry;
  writeFileSync(store.indexFile, JSON.stringify(index, null, 2), "utf8");

  const report = [
    `# Consolidation — ${problem}`,
    ``,
    `- campaign: ${events[0]?.campaignId ?? "?"} (${events.length} events)`,
    `- extracted: ${added} new knowledge objects (${skipped} already present — idempotent)`,
    `- verified claims: ${entry.verifiedClaims} | falsified: ${entry.falsifiedClaims} | dead-ends: ${entry.deadEnds} | skills: ${entry.skills.length}`,
    `- bounds reached: ${entry.bounds.map((b) => `[${b.min}, ${b.max}] (${b.variable})`).join(", ") || "none"}`,
  ].join("\n");
  writeFileSync(path.join(store.reportsDir, `${problem}.md`), report + "\n", "utf8");
  return { added, skipped, report };
}

/** Answer "is this already covered?" for a problem (+ optional question). */
export interface LookupResult {
  covered: boolean;
  runs: number;
  bounds: { variable: string; min: number; max: number }[];
  verifiedClaims: { statement: string; bound?: { variable: string; min: number; max: number } }[];
  deadEnds: string[];
  skills: string[];
  relatedProblems: string[];
}

export function lookup(store: KnowledgeStore, problem: string, question?: string): LookupResult {
  const index = loadIndex(store);
  const entry = index.entries[problem];
  const objects = [...loadObjects(store).values()];
  const mine = objects.filter((o) => o.problem === problem);
  if (!entry || mine.length === 0) {
    return { covered: false, runs: 0, bounds: [], verifiedClaims: [], deadEnds: [], skills: [], relatedProblems: [] };
  }
  const qt = question ? tokenize(question) : [];
  const related = qt.length > 0
    ? Object.entries(index.entries)
        .filter(([p]) => p !== problem)
        .map(([p, e]) => ({ p, score: relevance(qt, e.searchBlob) }))
        .filter((x) => x.score > 0.2)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((x) => x.p)
    : [];
  return {
    covered: true,
    runs: entry.runs.length,
    bounds: entry.bounds.map((b) => ({ variable: b.variable, min: b.min, max: b.max })),
    verifiedClaims: mine.filter((o) => o.kind === "claim" && o.status === "verified").slice(0, 10).map((o) => ({ statement: o.statement, bound: o.bound })),
    deadEnds: mine.filter((o) => o.kind === "dead-end").slice(0, 5).map((o) => o.statement.slice(0, 140)),
    skills: entry.skills.slice(0, 5),
    relatedProblems: related,
  };
}

/** Best bound reached for a problem (for T1 re-iteration triggers). */
export function bestBound(store: KnowledgeStore, problem: string): { variable: string; max: number } | null {
  const r = lookup(store, problem);
  if (r.bounds.length === 0) return null;
  return r.bounds.reduce<{ variable: string; max: number }>((a, b) => (b.max > a.max ? { variable: b.variable, max: b.max } : a), { variable: r.bounds[0].variable, max: r.bounds[0].max });
}

// ---- agent-distilled knowledge (v0.3.1) ----

export interface AgentLesson {
  kind: "lesson" | "generalized-skill" | "cross-link" | "synthesis";
  problem: string;
  title: string;
  body: string;
  /** REQUIRED: event ids from the source campaign journal that substantiate this lesson */
  sourceEventIds: string[];
  /** optional: object ids created by those events (claims, artifacts...) */
  sourceObjectIds?: string[];
  applicability?: string; // for generalized-skill: when/where this transfers
  relatedProblems?: string[]; // for cross-link
}

export interface LessonValidationResult {
  ok: boolean;
  reasons: string[];
  found: string[];
  missing: string[];
}

/**
 * ANTI-HALLUCINATION GATE: every lesson must cite REAL event ids from the journal.
 * A lesson without verifiable sources is rejected — the agent cannot invent history.
 */
export function validateLessonSources(lesson: AgentLesson, journalEventIds: Set<string>, journalObjectIds?: Set<string>): LessonValidationResult {
  const reasons: string[] = [];
  const found: string[] = [];
  const missing: string[] = [];
  if (!lesson.title || lesson.title.trim().length < 5) reasons.push("title too short");
  if (!lesson.body || lesson.body.trim().length < 20) reasons.push("body too short (min 20 chars)");
  if (!lesson.sourceEventIds || lesson.sourceEventIds.length === 0) {
    reasons.push("sourceEventIds is REQUIRED — a lesson without journal citations is not knowledge");
  } else {
    for (const id of lesson.sourceEventIds) {
      if (journalEventIds.has(id)) found.push(id);
      else missing.push(id);
    }
    if (missing.length > 0) reasons.push(`fabricated event ids cited: ${missing.join(", ")}`);
    if (found.length === 0 && lesson.sourceEventIds.length > 0) reasons.push("no cited event id exists in the journal");
  }
  if (lesson.sourceObjectIds && journalObjectIds) {
    const objMissing = lesson.sourceObjectIds.filter((id) => !journalObjectIds.has(id));
    if (objMissing.length > 0) reasons.push(`fabricated object ids: ${objMissing.join(", ")}`);
  }
  return { ok: reasons.length === 0, reasons, found, missing };
}

/** Write an agent-distilled lesson into the knowledge store (after validation). */
export function writeLesson(store: KnowledgeStore, lesson: AgentLesson, campaignId: string): KnowledgeObject {
  const now = new Date().toISOString();
  const obj: KnowledgeObject = {
    id: `ko_${hash8(`lesson|${lesson.problem}|${lesson.title}`)}`,
    kind: lesson.kind,
    problem: lesson.problem,
    statement: lesson.title,
    how: lesson.body.slice(0, 400),
    provenance: { campaignId, extractedAt: now },
    text: `${lesson.title} ${lesson.body} ${lesson.applicability ?? ""} ${(lesson.relatedProblems ?? []).join(" ")}`.slice(0, 2000),
  };
  appendFileSync(store.objectsFile, JSON.stringify(obj) + "\n", "utf8");
  return obj;
}
