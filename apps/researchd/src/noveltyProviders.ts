// noveltyProviders.ts — server-side novelty search fan-out (spec §5.2-5.4).
// Generic scholarly infrastructure: no auth for OEIS/arXiv/OpenAlex/Crossref;
// Semantic Scholar is optional and fails soft (rate limits without a key).
import type { CampaignProjection, ResearchCore } from "@research-os/core";
import { nowIso } from "@research-os/core";

export interface NoveltyHit {
  provider: string;
  title: string;
  url?: string;
  date?: string;
  snippet?: string;
}

const UA = "ResearchOS/0.2 (research novelty audit; contact: local)";
const TIMEOUT_MS = 10_000;

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": UA, accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}
async function getText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.text();
}

export async function oeisSearch(input: { terms?: string[]; query?: string; maxResults?: number }): Promise<NoveltyHit[]> {
  const q = input.terms && input.terms.length > 0 ? input.terms.join(",") : input.query ?? "";
  if (!q) return [];
  const url = `https://oeis.org/search?q=${encodeURIComponent(q)}&fmt=json&max=${input.maxResults ?? 8}`;
  const data = (await getJson(url)) as { results?: Array<{ number?: string; name?: string; data?: string }> };
  return (data.results ?? []).map((r) => ({
    provider: "oeis",
    title: `A${String(r.number ?? "?").padStart(6, "0")} ${r.name ?? ""}`.trim(),
    url: r.number ? `https://oeis.org/A${String(r.number).padStart(6, "0")}` : undefined,
    snippet: (r.data ?? "").slice(0, 120),
  }));
}

export async function arxivSearch(query: string, max = 5): Promise<NoveltyHit[]> {
  const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${max}`;
  const xml = await getText(url);
  const hits: NoveltyHit[] = [];
  for (const m of xml.matchAll(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<published>([\d-]{10})?[\s\S]*?<id>([\s\S]*?)<\/id>/g)) {
    hits.push({ provider: "arxiv", title: m[1].replace(/\s+/g, " ").trim(), url: m[3]?.trim(), date: m[2] });
    if (hits.length >= max) break;
  }
  return hits;
}

export async function openalexSearch(query: string, max = 5): Promise<NoveltyHit[]> {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${max}&mailto=researchos@localhost`;
  const data = (await getJson(url)) as { results?: Array<{ title?: string; publication_year?: number; id?: string; doi?: string }> };
  return (data.results ?? []).map((r) => ({
    provider: "openalex",
    title: r.title ?? "(untitled)",
    url: r.doi ?? r.id,
    date: r.publication_year ? String(r.publication_year) : undefined,
  }));
}

export async function crossrefSearch(query: string, max = 5): Promise<NoveltyHit[]> {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${max}`;
  const data = (await getJson(url)) as { message?: { items?: Array<{ title?: string[]; issued?: { "date-parts"?: number[][] }; DOI?: string }> } };
  return (data.message?.items ?? []).map((r) => ({
    provider: "crossref",
    title: r.title?.[0] ?? "(untitled)",
    url: r.DOI ? `https://doi.org/${r.DOI}` : undefined,
    date: r.issued?.["date-parts"]?.[0]?.[0] ? String(r.issued["date-parts"][0][0]) : undefined,
  }));
}

export async function semanticScholarSearch(query: string, max = 5): Promise<NoveltyHit[]> {
  // optional: public endpoint is aggressively rate-limited without a key
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${max}&fields=title,year,url`;
  const data = (await getJson(url)) as { data?: Array<{ title?: string; year?: number; url?: string }> };
  return (data.data ?? []).map((r) => ({ provider: "semantic-scholar", title: r.title ?? "(untitled)", url: r.url, date: r.year ? String(r.year) : undefined }));
}

export interface NoveltySearchOutcome {
  hits: NoveltyHit[];
  errors: string[];
  evidenceIds: string[];
}

/** Fan out one query to the requested providers (default: all free ones). */
export async function noveltySearch(
  core: ResearchCore,
  proj: CampaignProjection,
  input: { query: string; providers?: string[]; auditId?: string; terms?: string[]; maxPerQuery?: number },
): Promise<NoveltySearchOutcome> {
  const providers = input.providers && input.providers.length > 0 ? input.providers : ["oeis", "arxiv", "openalex", "crossref"];
  const jobs: Array<[string, Promise<NoveltyHit[]>]> = [];
  if (providers.includes("oeis")) jobs.push(["oeis", oeisSearch({ terms: input.terms, query: input.query, maxResults: input.maxPerQuery ?? 5 }).catch(() => Promise.reject(new Error("oeis")))]);
  if (providers.includes("arxiv")) jobs.push(["arxiv", arxivSearch(input.query, input.maxPerQuery ?? 5).catch(() => { throw new Error("arxiv"); })]);
  if (providers.includes("openalex")) jobs.push(["openalex", openalexSearch(input.query, input.maxPerQuery ?? 5).catch(() => { throw new Error("openalex"); })]);
  if (providers.includes("crossref")) jobs.push(["crossref", crossrefSearch(input.query, input.maxPerQuery ?? 5).catch(() => { throw new Error("crossref"); })]);
  if (providers.includes("semantic-scholar")) jobs.push(["semantic-scholar", semanticScholarSearch(input.query, input.maxPerQuery ?? 5).catch(() => { throw new Error("semantic-scholar"); })]);

  const hits: NoveltyHit[] = [];
  const errors: string[] = [];
  await Promise.allSettled(
    jobs.map(async ([name, p]) => {
      try {
        hits.push(...(await p));
      } catch {
        errors.push(name);
      }
    }),
  );

  // store every hit as a novelty_evidence object (spec §3.6 — searches are evidence)
  const evidenceIds: string[] = [];
  for (const h of hits) {
    const id = core.nextId(proj, "evidence");
    core.apply(proj, "object.created", { kind: "system", id: "novelty-search" }, {
      object: {
        id, campaignId: proj.state.id, type: "novelty_evidence",
        title: `[${h.provider}] ${h.title}`.slice(0, 160),
        content: {
          auditId: input.auditId,
          sourceType: h.provider,
          query: input.query,
          retrievedAt: nowIso(),
          resultTitle: h.title, resultRef: h.url, resultDate: h.date,
          relation: "related", // relation refined by the auditor role afterwards
          rationale: "automated provider hit — auditor must classify relation",
        },
        tags: ["novelty-evidence", h.provider],
        createdBy: "novelty-search",
        createdAt: nowIso(), updatedAt: nowIso(),
      },
    });
    evidenceIds.push(id);
  }
  return { hits, errors, evidenceIds };
}
