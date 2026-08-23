// extension/index.ts — ResearchOS Pi extension (spec §8, §40).
// Registers research_* tools that talk to the researchd HTTP API.
// Workers get fresh context per task; durable state lives in ResearchOS only.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const BASE = process.env.RESEARCH_URL ?? "http://127.0.0.1:8787";

function alias(): string {
  return process.env.RESEARCH_WORKER_ALIAS ?? `worker-${(process.env.PI_SESSION_ID ?? "local").slice(-6)}`;
}

function campaign(): string | undefined {
  return process.env.RESEARCH_CAMPAIGN;
}

async function api(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = typeof json.error === "string" ? json.error : text.slice(0, 500);
    throw new Error(`researchd ${res.status}: ${err}`);
  }
  return json;
}

function brief(v: unknown, max = 700): string {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 1);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

type ToolExecute = (toolCallId: string, params: Record<string, never>, signal: AbortSignal, onUpdate: (s: unknown) => void, ctx: unknown) => Promise<{ content: { type: "text"; text: string }[]; details?: unknown }>;

function tool(name: string, description: string, schema: Record<string, unknown>, run: (p: Record<string, never>) => Promise<string | { text: string; details?: unknown }>) {
  return {
    name,
    label: name,
    description,
    parameters: Type.Object(schema as never),
    async execute(_id: string, params: Record<string, never>) {
      try {
        const out = await run(params);
        if (typeof out === "string") return { content: [{ type: "text", text: out }] };
        return { content: [{ type: "text", text: out.text }], details: out.details ?? {} };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  } as const;
}

export default function (pi: ExtensionAPI): void {
  const who = { createdBy: alias(), provider: process.env.PI_PROVIDER, model: process.env.PI_MODEL };

  // ---------------- read tools ----------------
  pi.registerTool(
    tool("research_status", "Campaign status snapshot for this worker's campaign (or all campaigns).", {}, async () => {
      const out = campaign()
        ? await api("GET", `/v1/campaigns/${campaign()!.replace("campaign:", "")}`)
        : await api("GET", "/v1/campaigns");
      return brief(out);
    }),
  );

  pi.registerTool(
    tool("research_get_object", "Fetch one research object by id (e.g. hypothesis:h_3, claim:cl_2).", { id: Type.String({ description: "object id" }) }, async (p) => {
      const out = await api("GET", `/v1/objects/${encodeURIComponent(String(p.id))}`);
      return brief(out, 1500);
    }),
  );

  pi.registerTool(
    tool("research_query", "Search campaign objects by type / status / branch / text.", {
      campaignId: Type.Optional(Type.String()), type: Type.Optional(Type.String()), status: Type.Optional(Type.String()),
      branchId: Type.Optional(Type.String()), text: Type.Optional(Type.String()), k: Type.Optional(Type.Number()),
    }, async (p) => {
      const out = await api("POST", "/v1/query", { campaignId: String(p.campaignId ?? campaign()), ...p });
      return brief(out, 1200);
    }),
  );

  pi.registerTool(
    tool("research_retrieve", "Intent-specific memory retrieval: evidence | failures | skills | sources | analogies | similar_problems.", {
      intent: Type.String({ description: "retrieve_evidence|retrieve_failures|retrieve_skills|retrieve_sources|retrieve_analogies|retrieve_similar_problems|retrieve_known_methods" }),
      query: Type.String({ description: "natural language query" }), k: Type.Optional(Type.Number()),
    }, async (p) => {
      const out = await api("POST", "/v1/retrieve", { campaignId: campaign(), intent: String(p.intent), query: String(p.query), k: p.k ?? 5 });
      return brief(out, 1200);
    }),
  );

  pi.registerTool(
    tool("research_graph_expand", "Expand the research graph around an object id (neighbors + edges).", {
      id: Type.String(), depth: Type.Optional(Type.Number()),
    }, async (p) => {
      const out = await api("GET", `/v1/graph/expand?id=${encodeURIComponent(String(p.id))}&depth=${p.depth ?? 1}`);
      return brief(out, 1500);
    }),
  );

  pi.registerTool(
    tool("research_list_verifiers", "List deterministic verifiers AND exact-expression capabilities (functions, predicates, caps, modes) available to this campaign. Use THIS instead of reading module sources.", {}, async () => {
      const out = await api("GET", `/v1/verifiers${campaign() ? `?campaignId=${campaign()}` : ""}`);
      return brief(out, 2500);
    }),
  );

  // ---------------- coordination ----------------
  pi.registerTool(
    tool("research_claim_task", "Claim the next queued task (long-polls server-side). Returns the task + ContextPack (objective, branch, verified facts, failures, skills, output contract).", {
      role: Type.Optional(Type.String({ description: "prefer tasks of this role" })),
      waitSeconds: Type.Optional(Type.Number({ description: "block server-side up to this many seconds waiting for a task (default 120 when looping; 0 = immediate)" })),
    }, async (p) => {
      const wait = p.waitSeconds === undefined ? 120 : Math.min(Math.max(Number(p.waitSeconds), 0), 180);
      const out = await api("POST", "/v1/tasks/claim", {
        campaignId: campaign(), workerAlias: alias(), role: p.role ? String(p.role) : (process.env.RESEARCH_WORKER_ROLE || undefined),
        mode: process.env.PI_SESSION_FILE ? "interactive" : "headless",
        waitSeconds: wait,
      }, wait * 1000 + 10_000);
      if (!out.task) return "No queued task right now. Campaign may be between phases or not running. Stop your loop politely.";
      const t = out.task as Record<string, unknown>;
      const c = (out.context ?? {}) as Record<string, unknown>;
      const head = [
        `TASK ${t.id} — ${t.type} (${t.role}) round ${t.round} phase ${t.phase}`,
        `GOAL: ${t.goal}`,
        c.branch ? `BRANCH ${(c.branch as Record<string, unknown>).id}: ${String((c.branch as Record<string, unknown>).thesis).slice(0, 200)}` : "",
        c.moduleGuidance ? `MODULE GUIDANCE:\n${String(c.moduleGuidance)}` : "",
        `OUTPUT CONTRACT: ${c.outputContract}`,
        `BUDGET: ${c.budget}`,
        `PEERS: ${c.peerWorkNotice}`,
        c.objective ? `OBJECTIVE (v${String((c.objective as Record<string, unknown>).version)}): ${String((c.objective as Record<string, unknown>).statement)}` : "",
      ].filter(Boolean).join("\n");
      const extras = [
        formatItems("VERIFIED FACTS", c.verifiedFacts), formatItems("OPEN QUESTIONS", c.openQuestions),
        formatItems("RELEVANT FAILURES", c.relevantFailures), formatItems("SKILLS", c.relevantSkills),
        formatItems("ANALOGIES", c.analogousCases),
      ].filter(Boolean).join("\n");
      return { text: `${head}\n${extras}`, details: { task: t.id, contextHash: c.contextHash } };
    }),
  );

  pi.registerTool(
    tool("research_get_context", "Re-fetch your current task ContextPack.", {}, async () => {
      const out = await api("GET", `/v1/context?worker=${encodeURIComponent(alias())}`);
      return out.context ? brief(out.context, 2000) : "No active leased task.";
    }),
  );

  pi.registerTool(
    tool("research_release_task", "Release your leased task (you cannot complete it).", {
      taskId: Type.String(), reason: Type.String(),
    }, async (p) => {
      const out = await api("POST", `/v1/tasks/${encodeURIComponent(String(p.taskId))}/release`, { campaignId: campaign(), workerAlias: alias(), reason: String(p.reason) });
      return brief(out);
    }),
  );

  // ---------------- write tools ----------------
  pi.registerTool(
    tool("research_create_branch", "Open a new research branch with a distinct thesis (generation phase).", {
      thesis: Type.String(), methodTags: Type.Array(Type.String()), parentBranchIds: Type.Optional(Type.Array(Type.String())),
    }, async (p) => {
      const out = await api("POST", "/v1/branches", { campaignId: campaign(), ...p, createdBy: alias() });
      return `Branch created: ${brief(out)}`;
    }),
  );

  pi.registerTool(
    tool("research_create_hypothesis", "Propose a hypothesis (stored as speculative).", {
      title: Type.String(), statement: Type.String(), branchId: Type.Optional(Type.String()), rationale: Type.Optional(Type.String()), tags: Type.Optional(Type.Array(Type.String())),
    }, async (p) => {
      const out = await api("POST", "/v1/objects", { campaignId: campaign(), type: "hypothesis", epistemicStatus: "speculative", ...p, createdBy: alias() });
      return `Hypothesis created: ${brief(out)}`;
    }),
  );

  pi.registerTool(
    tool("research_create_claim", "State a precise falsifiable claim (stored as unverified — only verifiers promote it).", {
      title: Type.String(), statement: Type.String(), branchId: Type.Optional(Type.String()), tags: Type.Optional(Type.Array(Type.String())),
    }, async (p) => {
      const out = await api("POST", "/v1/objects", { campaignId: campaign(), type: "claim", epistemicStatus: "unverified", ...p, createdBy: alias() });
      return `Claim created: ${brief(out)}`;
    }),
  );

  pi.registerTool(
    tool("research_add_evidence", "Attach evidence to a claim. result: supports | contradicts | neutral.", {
      title: Type.String(), claimId: Type.String(), result: Type.String(), kind: Type.Optional(Type.String()),
      artifactRefs: Type.Optional(Type.Array(Type.String())), sourceRefs: Type.Optional(Type.Array(Type.String())), notes: Type.Optional(Type.String()),
    }, async (p) => {
      const out = await api("POST", "/v1/objects", {
        campaignId: campaign(), type: "evidence", title: String(p.title),
        content: { kind: p.kind ?? "observation", result: String(p.result), artifactRefs: p.artifactRefs ?? [], sourceRefs: p.sourceRefs ?? [], notes: p.notes ?? "" },
        targetId: String(p.claimId), relation: String(p.result) === "contradicts" ? "contradicts" : "supports",
        createdBy: alias(),
      });
      return `Evidence attached: ${brief(out)}`;
    }),
  );

  pi.registerTool(
    tool("research_record_observation", "Record an observation or anomaly.", {
      title: Type.String(), text: Type.String(), anomaly: Type.Optional(Type.Boolean()), branchId: Type.Optional(Type.String()),
    }, async (p) => {
      const out = await api("POST", "/v1/objects", {
        campaignId: campaign(), type: p.anomaly ? "anomaly" : "observation", title: String(p.title), content: { text: String(p.text) },
        branchId: p.branchId ? String(p.branchId) : undefined, createdBy: alias(),
      });
      return `Recorded: ${brief(out)}`;
    }),
  );

  pi.registerTool(
    tool("research_create_question", "Record an open research question.", { title: Type.String(), text: Type.String() }, async (p) => {
      const out = await api("POST", "/v1/objects", { campaignId: campaign(), type: "question", title: String(p.title), content: { text: String(p.text) }, createdBy: alias() });
      return `Question recorded: ${brief(out)}`;
    }),
  );

  pi.registerTool(
    tool("research_create_experiment", "Plan an experiment (purpose, method, expected outputs). Budgets experiments.", {
      title: Type.String(), purpose: Type.String(), method: Type.String(), branchId: Type.Optional(Type.String()), expectedOutputs: Type.Optional(Type.String()),
    }, async (p) => {
      const out = await api("POST", "/v1/objects", {
        campaignId: campaign(), type: "experiment", title: String(p.title),
        content: { purpose: String(p.purpose), method: String(p.method), expectedOutputs: p.expectedOutputs ?? "" },
        branchId: p.branchId ? String(p.branchId) : undefined, createdBy: alias(),
      });
      return `Experiment planned: ${brief(out)}`;
    }),
  );

  pi.registerTool(
    tool("research_create_artifact", "Register a workspace file (or inline base64) as an immutable content-addressed artifact.", {
      workspacePath: Type.Optional(Type.String({ description: "path relative to this workspace" })),
      contentBase64: Type.Optional(Type.String()), logicalName: Type.String(), branchId: Type.Optional(Type.String()),
    }, async (p) => {
      const out = await api("POST", "/v1/artifacts", { campaignId: campaign(), ...p, producer: alias() });
      return `Artifact registered: ${brief(out)}`;
    }),
  );

  pi.registerTool(
    tool("research_request_verification", "Request a deterministic verifier run against a claim (exit code decides; only this path sets verified/falsified).", {
      targetId: Type.String(), verifierId: Type.String(), input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }, async (p) => {
      const out = await api("POST", "/v1/verifications", { campaignId: campaign(), targetId: String(p.targetId), verifierId: String(p.verifierId), input: p.input ?? {}, requestedBy: alias() });
      const v = (out.verification ?? {}) as Record<string, unknown>;
      return `Verification ${v.status}: ${brief(v, 900)}`;
    }),
  );

  pi.registerTool(
    tool("research_propose_skill", "Propose a reusable research skill candidate (validation is manual — never auto-activated).", {
      name: Type.String(), activation: Type.Array(Type.String()), procedure: Type.Array(Type.String()),
      termination: Type.Optional(Type.Array(Type.String())), warnings: Type.Optional(Type.Array(Type.String())), evidenceRefs: Type.Optional(Type.Array(Type.String())),
    }, async (p) => {
      const out = await api("POST", "/v1/skills", { campaignId: campaign(), ...p, createdBy: alias() });
      return `Skill candidate recorded: ${brief(out)}`;
    }),
  );

  pi.registerTool(
    tool("research_submit_task_result", "Submit your task result envelope — the ONLY way to finish a task.", {
      taskId: Type.String(), status: Type.String({ description: "success | partial | failure" }),
      summary: Type.String(), createdObjects: Type.Optional(Type.Array(Type.String())),
      createdArtifacts: Type.Optional(Type.Array(Type.String())), evidence: Type.Optional(Type.Array(Type.String())),
      openQuestions: Type.Optional(Type.Array(Type.String())), blockers: Type.Optional(Type.Array(Type.String())),
      minutesUsed: Type.Optional(Type.Number()), idempotencyKey: Type.Optional(Type.String()),
      skillsUsed: Type.Optional(Type.Array(Type.String({ description: "ids of skills you actually applied" }))),
    }, async (p) => {
      const out = await api("POST", `/v1/tasks/${encodeURIComponent(String(p.taskId))}/result`, { ...p, campaignId: campaign(), workerAlias: alias() });
      const a = (out.audit ?? {}) as Record<string, unknown>;
      const reasons = Array.isArray(a.reasons) ? (a.reasons as string[]).join("; ") : "";
      return `Result ${out.accepted ? "ACCEPTED" : "REJECTED"}${out.duplicate ? " (duplicate — original stands)" : ""}${reasons ? ` — ${reasons}` : ""}`;
    }),
  );

  // ---------------- novelty & discovery (module v0.2) ----------------
  pi.registerTool(
    tool("research_novelty_search", "Fan out a novelty query to scholarly providers (oeis | arxiv | openalex | crossref | semantic-scholar). Each hit is stored as a novelty_evidence object with the query. Use multiple query VARIANTS (exact phrase, notation, definition keywords) — one query is never novelty evidence.", {
      query: Type.Optional(Type.String()),
      terms: Type.Optional(Type.Array(Type.String(), { description: "sequence terms for OEIS value search" })),
      providers: Type.Optional(Type.Array(Type.String())),
      auditId: Type.Optional(Type.String()),
    }, async (p) => {
      const out = await api("POST", "/v1/novelty/search", { campaignId: campaign(), ...p });
      const hits = (out.hits ?? []) as { provider: string; title: string }[];
      const lines = hits.map((h) => `- [${h.provider}] ${h.title.slice(0, 100)}`).join("\n");
      return `hits: ${hits.length}${out.errors?.length ? ` (provider errors: ${out.errors.join(",")})` : ""}\n${lines}\nevidence objects: ${((out.evidenceIds ?? []) as string[]).join(", ") || "none"}`;
    }),
  );

  pi.registerTool(
    tool("research_job_create", "Launch a DURABLE compute job (long search/experiment) as a detached process. NEVER run hours-long compute inside your own turns — write the script to experiments/, then create a job. Returns a job id; poll with research_job_status. The script's stdout becomes an immutable artifact; lines containing PROGRESS update the job metric; a final line {\"RESULT\": ...} is captured as the metric.", {
      name: Type.String(), command: Type.Array(Type.String()),
      cwd: Type.Optional(Type.String({ description: "relative to the campaign workspace" })),
      wallSeconds: Type.Optional(Type.Number({ description: "hard kill after this many seconds (default 3600)" })),
    }, async (p) => {
      const out = await api("POST", "/v1/jobs", { campaignId: campaign(), ...p, createdBy: alias() });
      return `job ${out.job.id} launched (pid ${out.job.pid ?? "?"}, status ${out.job.status})`;
    }),
  );

  pi.registerTool(
    tool("research_job_status", "Poll a compute job: status running/completed/failed/timeout, metric (last PROGRESS), stdout artifact ref.", { jobId: Type.String() }, async (p) => {
      const out = await api("GET", `/v1/jobs/${encodeURIComponent(String(p.jobId))}`);
      return brief(out, 700);
    }),
  );

  pi.registerTool(
    tool("research_frontier_snapshot", "Record a dated, sourced FRONTIER SNAPSHOT before any record hunt: the current public best (value, type lower-bound/record/...), the sources that establish it (with dates + confidence primary/curated/secondary), and the EXACT improvement predicate. A record hunt MUST NOT run from a hand-written number in a prompt.", {
      targetId: Type.String(), statement: Type.String(),
      frontierType: Type.String({ description: "lower-bound|upper-bound|record|sequence-prefix|smallest-known|largest-known" }),
      currentValue: Type.Optional(Type.String()),
      comparison: Type.Optional(Type.String()),
      improvementPredicate: Type.String(),
      sources: Type.Array(Type.Object({ sourceType: Type.String(), value: Type.String(), date: Type.Optional(Type.String()), ref: Type.Optional(Type.String()) })),
      sourceAgreement: Type.String(), confidence: Type.String(),
      certificateSpecId: Type.Optional(Type.String()), notes: Type.Optional(Type.Array(Type.String())),
    }, async (p) => {
      const out = await api("POST", "/v1/objects", {
        campaignId: campaign(), type: "frontier_snapshot", title: `frontier: ${String(p.targetId)} = ${String(p.currentValue ?? "?")} (${String(p.comparison ?? "")})`,
        content: { ...p, capturedAt: new Date().toISOString() }, createdBy: alias(), tags: ["frontier"],
      });
      return `frontier snapshot ${out.object.id} recorded (capturedAt now). Promotion gates will check freshness (24h for records).`;
    }),
  );

  pi.registerTool(
    tool("research_discovery_candidate", "Register a DISCOVERY CANDIDATE (quarantined): the statement, its correctness status (only exactly-verified counts for promotion), certificate artifact, frontier snapshot, metric. Novelty status is set by the novelty auditor separately — never by the claimant.", {
      candidateType: Type.String({ description: "new-object|sequence|record|conjecture|lemma|counterexample|structural-fact|method" }),
      statement: Type.String(),
      correctnessStatus: Type.String({ description: "unverified|computationally-supported|exactly-verified|formally-verified" }),
      certificateArtifactId: Type.Optional(Type.String()),
      frontierSnapshotId: Type.Optional(Type.String()),
      metric: Type.Optional(Type.String()), improvesFrontier: Type.Optional(Type.Boolean()),
    }, async (p) => {
      const out = await api("POST", "/v1/objects", {
        campaignId: campaign(), type: "discovery_candidate",
        title: `[${String(p.candidateType)}] ${String(p.statement).slice(0, 100)}`,
        content: { ...p, noveltyStatus: "unchecked", promotionStatus: "quarantined" }, createdBy: alias(), tags: ["candidate"],
      });
      return `candidate ${out.object.id} quarantined. Next: exact verification, novelty audit, then /v1/candidates/:id/promote review.`;
    }),
  );

  pi.registerTool(
    tool("research_candidate_promote", "Run the promotion gate on a discovery candidate: enforces correctness + novelty + fresh frontier (records). Terminal state is human-review — nothing auto-publishes.", { candidateId: Type.String() }, async (p) => {
      const out = await api("POST", `/v1/candidates/${encodeURIComponent(String(p.candidateId))}/promote`, { campaignId: campaign() });
      return brief(out);
    }),
  );

  // ---------------- human command ----------------
  pi.registerCommand("research", {
    description: "ResearchOS worker console — show campaign status",
    handler: async () => {
      try {
        const out = campaign()
          ? await api("GET", `/v1/campaigns/${campaign()!.replace("campaign:", "")}`)
          : await api("GET", "/v1/campaigns");
        console.log(brief(out, 2000));
      } catch (err) {
        console.log(`researchd unreachable at ${BASE}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("research", `ResearchOS worker ${alias()} → ${BASE}`);
    return undefined;
  });
}

function formatItems(label: string, items: unknown): string {
  if (!Array.isArray(items) || items.length === 0) return "";
  const lines = items.map((i) => {
    const it = i as Record<string, unknown>;
    return `- ${String(it.title ?? "?")} [${String(it.ref ?? it.id ?? "")}]${it.epistemicStatus ? ` (${String(it.epistemicStatus)})` : ""} ${String(it.snippet ?? "").slice(0, 160)}`;
  });
  return `${label}:\n${lines.join("\n")}`;
}
