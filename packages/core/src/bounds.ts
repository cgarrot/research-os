// bounds.ts — claim↔verifier-domain consistency (V0.2.1).
// The verifier verdict carries the REAL tested domain; claims must not state more.
// Strict rule: structured claim.bound vs realCoverage (refuses transition on mismatch).
// Heuristic: numbers in title/statement vs coverage (flags, never blocks — legacy claims).
import type { ResearchObject, VerificationRecord } from "@research-os/contracts";

export interface VerifiedDomain {
  mode: "point" | "exhaustive" | "witness" | "symbolic";
  expression: string;
  variables: { name: string; min: number; max: number }[];
  testedCases: number;
  /** Real covered interval per natural variable after expression mapping (absent = raw domain only). */
  realCoverage?: { variable: string; min: number; max: number; note?: string }[];
}

export interface ClaimBound {
  variable: string;
  min: number;
  max: number;
  unit?: string;
}

/** Parse the verdict JSON emitted by module scripts (LAST json line containing "mode"). */
export function parseVerdict(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try {
      const v = JSON.parse(lines[i]) as Record<string, unknown>;
      if (typeof v.mode === "string") return v;
    } catch {
      /* not json */
    }
  }
  return null;
}

const SUPERS: Record<string, string> = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9" };

/** Map tested variable ranges through the expression to the natural claim variable. */
export function realCoverage(verdict: Record<string, unknown>): VerifiedDomain["realCoverage"] {
  const expr = String(verdict.expression ?? "").replace(/\s+/g, "");
  const vars = Array.isArray(verdict.variables) ? (verdict.variables as unknown[]) : [];
  const out: VerifiedDomain["realCoverage"] = [];
  for (const raw of vars) {
    let name: string, lo: number, hi: number;
    if (Array.isArray(raw)) {
      name = String(raw[0]); lo = Number(raw[1]); hi = Number(raw[2]);
    } else {
      const v = raw as { name?: unknown; min?: unknown; max?: unknown };
      name = String(v.name ?? "?"); lo = Number(v.min ?? 0); hi = Number(v.max ?? 0);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    const mul = (a: number, b: number) => [a, b] as const;
    // multiplicative/affine maps: k*m+c forms and m*m (quadratic windows)
    const affine = /(?:^|[^a-z0-9_])(\d*)\*?m(?:([+-])(\d+))?(?:[^a-z0-9_]|$)/.exec(expr);
    if (/m\*m|\(m\+1\)\*\(m\+1\)|m\*\*2/.test(expr)) {
      const w = mul(lo, hi);
      out.push({ variable: "n", min: w[0] * w[0], max: (w[1] + 1) * (w[1] + 1), note: `n² window from m∈[${lo},${hi}]` });
      continue;
    }
    if (affine) {
      const k = affine[1] === "" || affine[1] === undefined ? 1 : Number(affine[1]);
      const c = affine[2] === "-" ? -Number(affine[3] ?? 0) : affine[2] === "+" ? Number(affine[3] ?? 0) : 0;
      if (k >= 1) out.push({ variable: "n", min: k * lo + c, max: k * hi + c, note: `linear map ${k}*m${c ? (c > 0 ? "+" : "") + c : ""}` });
      continue;
    }
    if (/factorial\(/.test(expr)) {
      out.push({ variable: "n", min: lo, max: hi, note: `factorial argument m∈[${lo},${hi}]` });
      continue;
    }
    out.push({ variable: name, min: lo, max: hi });
  }
  return out.length > 0 ? out : undefined;
}

export function verdictToDomain(verdict: Record<string, unknown>): VerifiedDomain {
  return {
    mode: (["point", "exhaustive", "witness", "symbolic"].includes(String(verdict.mode)) ? verdict.mode : "point") as VerifiedDomain["mode"],
    expression: String(verdict.expression ?? ""),
    variables: (Array.isArray(verdict.variables) ? (verdict.variables as unknown[]).map((r) => {
      if (Array.isArray(r)) return { name: String(r[0]), min: Number(r[1]), max: Number(r[2]) };
      const v = r as { name?: unknown; min?: unknown; max?: unknown };
      return { name: String(v.name ?? "?"), min: Number(v.min ?? 0), max: Number(v.max ?? 0) };
    }) : []),
    testedCases: Number(verdict.testedCases ?? verdict.totalCases ?? 1),
    realCoverage: realCoverage(verdict),
  };
}

function bracketInner(inner: string): string {
  const trimmed = inner.trim();
  // "1, 500" or "1,500" (two short groups) → range endpoints
  if (/^\d{1,4}\s*,\s*\d{1,7}$/.test(trimmed)) return trimmed.replace(/\s*,\s*/g, "|");
  // pure thousands like "5,000,000" → one number
  if (/^\d{1,3}(,\d{3})+$/.test(trimmed)) return trimmed.replace(/,/g, "");
  // mixed: "1, 5,000,000" → split endpoints on comma+space, thousands within
  return trimmed.split(/,\s+/).map((part) => part.replace(/,/g, "")).join("|");
}

/** Numbers ≥ 100 that plausibly state a bound, in claim text. Best-effort. */
export function announcedBounds(text: string): number[] {
  // ranges FIRST (before thousand-separator stripping): "[1,500]" / "[1, 5,000,000]" are endpoints.
  let t = text.replace(/[\[(]([^\)\]]*)[\])]/g, (_m: string, inner: string) => `|${bracketInner(String(inner))}|`);
  t = t.replace(/,/g, "").replace(/\s/g, "");
  t = t.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (m) => m.split("").map((c) => SUPERS[c] ?? "").join(""));
  // unify 10^5 / 10**5 / 1e5 forms to their value
  const out = new Set<number>();
  for (const m of t.matchAll(/(\d+)(?:\^|\*\*)(\d+)/g)) {
    const base = Number(m[1]);
    const exp = Number(m[2]);
    if (base === 10 && exp <= 30) out.add(10 ** exp);
  }
  const cleaned = t.replace(/(\d+)(?:\^|\*\*)(\d+)/g, " ").replace(/[0-9]e[0-9]+/g, (m) => {
    const [a, b] = m.split("e");
    const v = Number(a) * 10 ** Number(b);
    if (v >= 100) out.add(v);
    return " ";
  });
  for (const m of cleaned.matchAll(/\d{3,}/g)) {
    const n = Number(m[0]);
    if (n >= 100 && n < 1e30) out.add(n);
  }
  return [...out];
}

export interface BoundCheck {
  ok: boolean;
  strict: boolean;
  flagged: boolean;
  claimed?: number;
  coveredMax?: number;
  detail: string;
}

/** Strict check: structured bound vs real coverage (>=95% of claimed range must be covered). */
function strictCheck(bound: ClaimBound, domain: VerifiedDomain): BoundCheck {
  const cov = domain.realCoverage?.find((r) => r.variable === bound.variable) ?? domain.realCoverage?.[0];
  const coveredMax = cov?.max ?? Math.max(...domain.variables.map((v) => v.max), 0);
  const coveredMin = cov?.min ?? Math.min(...domain.variables.map((v) => v.min), 0);
  if (bound.max <= coveredMax + Math.max(1, 0.05 * Math.abs(bound.max)) && bound.min >= coveredMin - Math.max(1, 0.05 * Math.abs(bound.min || 1))) {
    return { ok: true, strict: true, flagged: false, coveredMax, detail: `bound [${bound.min},${bound.max}] covered by [${coveredMin},${coveredMax}]` };
  }
  return { ok: false, strict: true, flagged: true, claimed: bound.max, coveredMax, detail: `claimed [${bound.min},${bound.max}] but verified only [${coveredMin},${coveredMax}]` };
}

/** Heuristic: any announced number far above coverage flags (never blocks). */
function heuristicCheck(claimText: string, domain: VerifiedDomain): BoundCheck {
  const covMax = Math.max(...(domain.realCoverage ?? domain.variables).map((r) => r.max), 0);
  const nums = announcedBounds(claimText).filter((n) => n >= 100 && n <= 1e15);
  const bad = nums.filter((n) => n > covMax * 1.5 + 10);
  if (bad.length > 0 && covMax > 0) {
    return { ok: true, strict: false, flagged: true, claimed: Math.max(...bad), coveredMax: covMax, detail: `announced ${bad.join(",")} vs verified ≤${covMax}` };
  }
  return { ok: true, strict: false, flagged: false, coveredMax: covMax, detail: "consistent" };
}

export function checkBoundConsistency(claim: Pick<ResearchObject, "title" | "content">, domain: VerifiedDomain): BoundCheck {
  const bound = (claim.content as Record<string, unknown>).bound as ClaimBound | undefined;
  const text = `${claim.title} ${JSON.stringify(claim.content.statement ?? "")}`;
  if (domain.mode === "point" || domain.mode === "symbolic") {
    return { ok: true, strict: false, flagged: false, detail: `${domain.mode} verification — no range claim expected` };
  }
  if (bound && Number.isFinite(bound.min) && Number.isFinite(bound.max)) return strictCheck(bound, domain);
  return heuristicCheck(text, domain);
}

/** For check-bounds.mjs (offline): same heuristic over a record's stored domain. */
export function auditRecord(claim: Pick<ResearchObject, "title" | "content">, record: Pick<VerificationRecord, "verifiedDomain">): BoundCheck | null {
  if (!record.verifiedDomain) return null;
  return checkBoundConsistency(claim, record.verifiedDomain);
}
