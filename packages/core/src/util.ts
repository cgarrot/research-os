// util.ts — small helpers, zero deps.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function randHex(n: number): string {
  return randomBytes(Math.ceil(n / 2)).toString("hex").slice(0, n);
}

export function slugify(s: string, max = 24): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max) || "campaign"
  );
}

export function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${randHex(6)}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "and", "or", "to", "in", "on", "is", "are", "be", "as", "by",
  "with", "that", "this", "it", "we", "you", "i", "not", "no", "do", "does", "did", "can",
  "could", "should", "would", "may", "might", "will", "shall", "must", "from", "at", "into",
  "les", "des", "une", "un", "la", "le", "de", "du", "et", "ou", "pour", "dans", "sur", "est",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9àâçéèêëîïôûùüÿñæœ+#_-]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Token-overlap relevance score in [0,1]. */
export function relevance(queryTokens: string[], docText: string): number {
  if (queryTokens.length === 0) return 0;
  const docTokens = new Set(tokenize(docText));
  let hits = 0;
  for (const t of queryTokens) if (docTokens.has(t)) hits++;
  return hits / queryTokens.length;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          onTimeout();
          resolve(null);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}
