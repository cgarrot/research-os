// novelty.ts — the discovery layer's pure logic (spec §3-5, §18, §22).
// Object STORAGE is generic (workers create them via /v1/objects with these
// content shapes); this module owns the state machines and the math-free rules.
import type { ResearchObject } from "@research-os/contracts";

// ---- content shapes (stored inside generic objects) ----

export type FrontierType =
  | "lower-bound" | "upper-bound" | "record" | "sequence-prefix"
  | "smallest-known" | "largest-known" | "classification" | "existence"
  | "nonexistence" | "unknown";

export interface FrontierClaimSource {
  sourceType: "primary" | "curated" | "secondary" | "weak";
  value: string;
  date?: string;
  ref?: string;
}

export interface FrontierSnapshotContent {
  targetId: string;
  capturedAt: string;
  frontierType: FrontierType;
  statement: string;
  currentValue?: string;
  comparison?: ">" | ">=" | "<" | "<=" | "=";
  improvementPredicate: string;
  certificateSpecId?: string;
  sources: FrontierClaimSource[];
  sourceAgreement: "agree" | "conflict" | "partial";
  confidence: "primary" | "curated" | "secondary" | "weak";
  notes?: string[];
}

export interface NoveltyEvidenceContent {
  auditId: string;
  sourceType: "oeis" | "openalex" | "semantic-scholar" | "arxiv" | "crossref" | "web" | "database" | "human";
  query: string;
  retrievedAt: string;
  resultTitle?: string;
  relation: "exact-match" | "probable-match" | "related" | "no-match" | "conflicting-frontier" | "supports-frontier";
  rationale: string;
}

export type NoveltyStatus =
  | "unchecked" | "known" | "likely-known" | "ambiguous" | "not-found"
  | "likely-new-after-audited-search" | "human-confirmed-new" | "human-rejected-novelty";

export interface NoveltyAuditContent {
  subjectId: string;
  subjectKind: "statement" | "sequence" | "object" | "certificate" | "record" | "lemma" | "method";
  mode: "quick" | "standard" | "deep";
  startedAt: string;
  completedAt?: string;
  providersCovered: string[];
  exactMatchQueries: number;
  definitionQueries: number;
  structuralQueries: number;
  recentWindowSearched: boolean;
  evidenceIds: string[];
  status: NoveltyStatus;
  confidence: number;
  missingCoverage: string[];
  humanReviewRequired: boolean;
}

export type CandidateType =
  | "new-object" | "sequence" | "record" | "conjecture" | "lemma"
  | "counterexample" | "structural-fact" | "method";

export interface DiscoveryCandidateContent {
  candidateType: CandidateType;
  statement: string;
  correctnessStatus: "unverified" | "computationally-supported" | "exactly-verified" | "formally-verified" | "falsified";
  noveltyStatus: NoveltyStatus;
  certificateArtifactId?: string;
  noveltyAuditId?: string;
  frontierSnapshotId?: string;
  metric?: string;
  improvesFrontier?: boolean;
  promotionStatus: "quarantined" | "candidate" | "human-review" | "accepted-result" | "rejected";
}

// ---- frontier resolution (spec §4.4, §22 fixtures) ----

const CONF_RANK: Record<FrontierClaimSource["sourceType"], number> = { primary: 3, curated: 2, secondary: 1, weak: 0 };

export interface ResolvedFrontier {
  value: string;
  confidence: FrontierSnapshotContent["confidence"];
  sourceAgreement: FrontierSnapshotContent["sourceAgreement"];
  chosen: FrontierClaimSource;
  notes: string[];
}

/** Resolve multiple dated claims into one frontier WITHOUT silently favoring numbers. */
export function resolveFrontier(claims: FrontierClaimSource[]): ResolvedFrontier {
  if (claims.length === 0) throw new Error("no claims");
  const best = [...claims].sort((a, b) => (CONF_RANK[b.sourceType] - CONF_RANK[a.sourceType]) || (b.date ?? "").localeCompare(a.date ?? ""));
  const top = best[0];
  const sameClass = claims.filter((c) => c.sourceType === top.sourceType);
  const values = [...new Set(sameClass.map((c) => c.value))];
  const notes: string[] = [];
  let agreement: ResolvedFrontier["sourceAgreement"] = "agree";
  if (values.length > 1) {
    agreement = "conflict";
    notes.push(`same-class sources disagree: ${sameClass.map((c) => `${c.value}(${c.date ?? "?"})`).join(" vs ")}`);
  } else if (new Set(claims.map((c) => c.value)).size > 1) {
    agreement = "partial";
    notes.push("lower-confidence sources disagree with the resolved value");
  }
  return {
    value: agreement === "conflict" ? top.value : values[0] ?? top.value,
    confidence: agreement === "conflict" ? top.sourceType : (top.sourceType as ResolvedFrontier["confidence"]),
    sourceAgreement: agreement,
    chosen: top,
    notes,
  };
}

const COMPETITIVE_TTL_HOURS = 24;

export function frontierTtlHours(s: Pick<FrontierSnapshotContent, "frontierType">): number {
  // competitive computational records go stale fast; classifications slowly
  if (s.frontierType === "lower-bound" || s.frontierType === "record" || s.frontierType === "largest-known") return COMPETITIVE_TTL_HOURS;
  if (s.frontierType === "sequence-prefix" || s.frontierType === "smallest-known") return 24 * 14;
  return 24 * 90;
}

export function isStale(snapshot: Pick<FrontierSnapshotContent, "capturedAt" | "frontierType">, now = Date.now()): boolean {
  const ageH = (now - Date.parse(snapshot.capturedAt)) / 3_600_000;
  return ageH > frontierTtlHours(snapshot);
}

function numeric(v: string | undefined): number | null {
  if (v === undefined) return null;
  const m = /-?\d+(\.\d+)?/.exec(v.replace(/,/g, ""));
  return m ? Number(m[0]) : null;
}

/** Strict improvement test against a snapshot (spec fixture 4: candidate vs live refresh). */
export function improvesFrontier(candidateMetric: string, snapshot: Pick<FrontierSnapshotContent, "currentValue" | "frontierType" | "comparison">): boolean {
  const c = numeric(candidateMetric);
  const f = numeric(snapshot.currentValue);
  if (c === null || f === null) return false;
  if (snapshot.frontierType === "upper-bound") return c < f;
  return c > f; // lower-bound / record / largest-known / sequence-prefix(length)
}

// ---- novelty status machine (spec §5.5) ----

export interface AuditCoverage {
  mode: "quick" | "standard" | "deep";
  providers: string[];
  subjectKind: NoveltyAuditContent["subjectKind"];
  exactMatchQueries: number;
  definitionQueries: number;
  structuralQueries: number;
  recentWindowSearched: boolean;
  probableMatches: number;
  providerErrors: number;
}

export function deriveNoveltyStatus(cov: AuditCoverage, hasMatch: boolean): { status: NoveltyStatus; missing: string[] } {
  const missing: string[] = [];
  if (hasMatch) return { status: "known", missing };
  if (cov.probableMatches > 0) return { status: "ambiguous", missing: ["unresolved probable match"] };

  const minProviders = cov.mode === "quick" ? 2 : cov.mode === "standard" ? 3 : 4;
  if (cov.providers.length < minProviders) missing.push(`providers ${cov.providers.length}/${minProviders}`);
  if (cov.exactMatchQueries < (cov.mode === "quick" ? 1 : 2)) missing.push("exact-match queries");
  if (cov.mode !== "quick" && cov.definitionQueries < 1) missing.push("definition-level queries");
  if (cov.mode === "deep" && cov.structuralQueries < 1) missing.push("structural query");
  if (cov.mode !== "quick" && !cov.recentWindowSearched) missing.push("recent literature window");
  if (cov.subjectKind === "sequence" && !cov.providers.includes("oeis")) missing.push("OEIS coverage required for sequences");
  // a provider outage must never manufacture novelty (spec §28)
  if (cov.providerErrors > 0 && cov.providers.length <= minProviders) missing.push("provider outage — coverage inconclusive");

  if (cov.mode === "quick") return { status: missing.length === 0 ? "not-found" : "unchecked", missing };
  return { status: missing.length === 0 ? "likely-new-after-audited-search" : "not-found", missing };
}

// ---- promotion matrix (spec §18.1) ----

export interface PromotionCheck {
  ok: boolean;
  promotionStatus: DiscoveryCandidateContent["promotionStatus"];
  reasons: string[];
}

export function promotionCheck(c: DiscoveryCandidateContent, frontierFresh: boolean): PromotionCheck {
  const reasons: string[] = [];
  if (c.correctnessStatus === "unverified" || c.correctnessStatus === "falsified" || c.correctnessStatus === "computationally-supported") {
    return { ok: false, promotionStatus: "quarantined", reasons: [`correctness ${c.correctnessStatus} — exact verification required`] };
  }
  if (c.noveltyStatus === "unchecked") return { ok: false, promotionStatus: "candidate", reasons: ["novelty unchecked — audit required"] };
  if (c.noveltyStatus === "known") return { ok: false, promotionStatus: "rejected", reasons: ["already known — store as reproduction"] };
  if (c.noveltyStatus === "human-rejected-novelty") return { ok: false, promotionStatus: "rejected", reasons: ["novelty rejected by human"] };
  if (c.noveltyStatus === "ambiguous" || c.noveltyStatus === "likely-known") {
    return { ok: false, promotionStatus: "candidate", reasons: [`novelty ${c.noveltyStatus} — deeper audit / human review`] };
  }
  if (!(c.noveltyStatus === "likely-new-after-audited-search" || c.noveltyStatus === "human-confirmed-new")) {
    return { ok: false, promotionStatus: "candidate", reasons: [`novelty ${c.noveltyStatus}`] };
  }
  if (c.candidateType === "record") {
    if (!c.frontierSnapshotId) reasons.push("record candidate must reference a frontier snapshot");
    if (!frontierFresh) reasons.push("frontier snapshot is stale — refresh immediately before promotion");
    if (c.improvesFrontier !== true) reasons.push("improvement predicate not established against the refreshed frontier");
  }
  if (reasons.length > 0) return { ok: false, promotionStatus: "candidate", reasons };
  // human gate is ALWAYS the terminal state — nothing auto-publishes
  return { ok: true, promotionStatus: "human-review", reasons: [] };
}

export function asFrontierSnapshot(o: ResearchObject | undefined): FrontierSnapshotContent | null {
  if (!o || o.type !== "frontier_snapshot") return null;
  return o.content as unknown as FrontierSnapshotContent;
}
export function asCandidate(o: ResearchObject | undefined): DiscoveryCandidateContent | null {
  if (!o || o.type !== "discovery_candidate") return null;
  return o.content as unknown as DiscoveryCandidateContent;
}
