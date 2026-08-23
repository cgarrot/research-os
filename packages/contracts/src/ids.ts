// ids.ts — stable addressable ids (spec §2.8).
// Format: "<type>:<prefix>_<seq>" e.g. "hypothesis:h_92", "task:t_882".
// Sequences are per (campaign, type) so ids stay short, readable and unique.

export type ResearchObjectRef = string;

const TYPE_PREFIXES: Record<string, string> = {
  campaign: "c",
  objective: "o",
  branch: "b",
  question: "q",
  hypothesis: "h",
  claim: "cl",
  evidence: "e",
  observation: "ob",
  anomaly: "an",
  experiment: "ex",
  artifact: "a",
  source: "s",
  skill: "sk",
  failure: "f",
  decision: "d",
  task: "t",
  verification: "v",
  agent_run: "r",
  note: "n",
  memory: "m",
  edge: "ed",
  event: "evt",
};

export function prefixFor(type: string): string {
  return TYPE_PREFIXES[type] ?? type.slice(0, 3).toLowerCase();
}

/** Build a readable id from a type and a per-campaign sequence number. */
export function makeId(type: string, seq: number): string {
  return `${type}:${prefixFor(type)}_${seq}`;
}

/** Parse "hypothesis:h_92" -> { type: "hypothesis", seq: 92 }. */
export function parseId(ref: ResearchObjectRef): { type: string; seq: number } | null {
  const m = /^([a-z_]+):([a-z]+)_(\d+)$/.exec(ref);
  if (!m) return null;
  return { type: m[1], seq: Number(m[3]) };
}

export function objectTypeOf(ref: ResearchObjectRef): string | null {
  return parseId(ref)?.type ?? null;
}
