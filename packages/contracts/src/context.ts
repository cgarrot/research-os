// context.ts — ContextPack: constructed, not accumulated (spec §15.5, §26).

import type { TaskSpec } from "./tasks.js";

export interface ContextItem {
  ref: string;
  title: string;
  snippet: string;
  epistemicStatus?: string;
}

export interface ToolCapabilitySummary {
  name: string;
  description: string;
}

export interface ContextPack {
  task: TaskSpec;
  objective: {
    id: string;
    statement: string;
    version: number;
    contentHash?: string;
    successCriteria: string[];
  };
  branch?: {
    id: string;
    thesis: string;
    methodTags: string[];
    status: string;
  };
  workerContract: string;
  verifiedFacts: ContextItem[];
  openQuestions: ContextItem[];
  relevantSources: ContextItem[];
  relevantSkills: ContextItem[];
  relevantFailures: ContextItem[];
  analogousCases: ContextItem[];
  /** lessons harvested from OTHER campaigns (workspace-global negative memory) — V0.4 */
  globalLessons?: ContextItem[];
  peerWorkNotice: string; // e.g. blind mode notice (do not consult peers)
  moduleGuidance?: string; // domain-module phase/worker guidance
  toolGuide: ToolCapabilitySummary[];
  budget: string;
  outputContract: string;
  contextHash: string;
}
