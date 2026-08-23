// server.ts — tiny zero-dep HTTP API + SSE (spec §57 subset).
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CampaignSpec, ResearchEvent, RetrievalIntent } from "@research-os/contracts";
import { VERIFIER_ONLY_STATUSES, EPISTEMIC_STATUSES } from "@research-os/contracts";
import {
  ResearchCore,
  type CampaignProjection,
  claimTask,
  submitResult,
  releaseTask,
  queuedTasks,
  registerArtifact,
  readArtifact,
  runVerification,
  verifierById,
  verifiersForCampaign,
  loadModules,
  proposeSkill,
  retrieve,
  buildReport,
  saveReport,
  createCampaign,
  startCampaign,
  pauseCampaign,
  resumeCampaign,
  stopCampaign,
  campaignRoom,
  buildContextPack,
} from "@research-os/core";

export interface DaemonContext {
  core: ResearchCore;
  modulesDir: string;
  piPackageDir: string;
  mesh: { status(): Promise<unknown>; broadcast(room: string, message: string, refs?: string[]): Promise<unknown> };
  jobs?: { create(proj: import("@research-os/core").CampaignProjection, input: { name: string; command: string[]; cwd?: string; wallSeconds?: number; createdBy: string }): unknown };
  /** knowledge duplicate lookup (v0.3) — returns the established claim when a title duplicates it */
  knowledgeLookup?: (title: string) => { statement: string; provenance: string } | null;
  /** scheduler heartbeat for the watchdog (null when absent, e.g. tests) */
  schedulerHealth?: () => { lastTickMs: number; tickCount: number; tickErrors: number } | null;
}

export async function handleRequest(ctx: DaemonContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p)); // ["v1", ...]
  const body = await readBody(req);

  try {
    const result = await route(ctx, req.method ?? "GET", parts, url.searchParams, body);
    if (result === null) {
      json(res, 404, { error: "not found" });
      return;
    }
    if (result instanceof RawResponse) {
      res.writeHead(result.status, result.headers);
      res.end(result.body);
      return;
    }
    json(res, 200, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    json(res, 400, { error: message });
  }
}

class RawResponse {
  constructor(
    readonly status: number,
    readonly headers: Record<string, string>,
    readonly body: string | Buffer,
  ) {}
}

async function route(
  ctx: DaemonContext,
  method: string,
  parts: string[],
  query: URLSearchParams,
  body: Record<string, unknown>,
): Promise<unknown> {
  const { core } = ctx;
  const [v, resource, a, b] = parts;

  if (v !== "v1") return null;

  if (resource === "health" && method === "GET") {
    return { ok: true, campaigns: core.listCampaigns().length, pid: process.pid, version: "0.1.0", scheduler: ctx.schedulerHealth ? ctx.schedulerHealth() : null };
  }

  if (resource === "campaigns") {
    if (method === "GET" && !a) {
      return core.listCampaigns().map((p) => campaignSummary(p));
    }
    if (method === "POST" && !a) {
      const spec = body.spec as CampaignSpec;
      if (!spec?.title || !spec.objective?.statement) throw new Error("spec needs title and objective.statement");
      const modules = loadModules([ctx.modulesDir]);
      const proj = createCampaign(core, normalizeSpec(spec), { piPackageDir: ctx.piPackageDir, modules });
      void ctx.mesh.broadcast(campaignRoom(proj.state.id), `Campaign ${proj.state.id} created: ${proj.state.title}. Room ${campaignRoom(proj.state.id)}.`);
      return { id: proj.state.id, workspace: proj.workspaceDir };
    }
    const proj = core.getCampaign(a?.startsWith("campaign:") ? a : `campaign:${a}`);
    if (!proj) throw new Error(`unknown campaign ${a}`);
    if (method === "GET" && !b) return campaignSummary(proj);
    if (b === "start" && method === "POST") {
      startCampaign(core, proj);
      void ctx.mesh.broadcast(campaignRoom(proj.state.id), `Campaign ${proj.state.id} STARTED — objective: ${proj.state.objective.statement}`);
      return campaignSummary(proj);
    }
    if (b === "pause" && method === "POST") { pauseCampaign(core, proj); return campaignSummary(proj); }
    if (b === "resume" && method === "POST") { resumeCampaign(core, proj); return campaignSummary(proj); }
    if (b === "stop" && method === "POST") { stopCampaign(core, proj, String(body.reason ?? "operator")); return campaignSummary(proj); }
    if (b === "frontier" && method === "GET") {
      // V0.7.2: math frontier snapshot (spec §21) derived from projection
      const claims = [...proj.objects.values()].filter((o) => ["claim", "hypothesis"].includes(o.type));
      const pendingVerifications = [...proj.verifications.values()].filter((v) => v.status === "pending").map((v) => v.id);
      const queuedByRole: Record<string, number> = {};
      for (const t of proj.tasks.values()) if (t.status === "queued") queuedByRole[t.role] = (queuedByRole[t.role] ?? 0) + 1;
      return {
        campaignId: proj.state.id,
        status: proj.state.status,
        round: proj.state.currentRound,
        openStatements: claims.filter((c) => !c.epistemicStatus || ["speculative", "unverified"].includes(c.epistemicStatus)).map((c) => c.id),
        verifiedLemmas: claims.filter((c) => c.epistemicStatus === "verified").map((c) => c.id),
        falsifiedStatements: claims.filter((c) => c.epistemicStatus === "falsified").map((c) => c.id),
        activeBranches: [...proj.branches.values()].filter((b) => b.status === "active" || b.status === "seeded").map((b) => ({ id: b.id, methodTags: b.methodTags, acceptedCount: b.acceptedCount })),
        unresolvedObstructions: [...proj.memories.values()].filter((m) => m.kind === "negative").slice(0, 10).map((m) => m.title),
        unexplainedAnomalies: [...proj.objects.values()].filter((o) => o.type === "anomaly").slice(0, 10).map((o) => o.id),
        pendingVerifications,
        queuedByRole,
        budgets: proj.state.budgets,
      };
    }
    if (b === "report" && method === "GET") {
      const md = buildReport(proj);
      const file = saveReport(proj, md);
      return new RawResponse(200, { "content-type": "text/markdown; charset=utf-8", "x-report-file": file }, md);
    }
    if (b === "events" && method === "GET") {
      const store = proj.store.readAll();
      const limit = Number(query.get("limit") ?? 100);
      return store.slice(-limit);
    }
    if (b === "branches" && method === "GET") return [...proj.branches.values()];
    if (b === "workers" && method === "GET") return [...proj.agentRuns.values()];
    if (b === "tasks" && method === "GET") {
      const status = query.get("status");
      return [...proj.tasks.values()].filter((t) => !status || t.status === status);
    }
    return null;
  }

  if (resource === "branches" && method === "POST" && !a) {
    const proj = core.requireCampaign(String(body.campaignId));
    const id = core.nextId(proj, "branch");
    const now = new Date().toISOString();
    const branch = {
      id, campaignId: proj.state.id, parentBranchIds: (body.parentBranchIds ?? []) as string[],
      thesis: String(body.thesis ?? "(no thesis)"), methodTags: (body.methodTags ?? []) as string[],
      status: "seeded" as const, taskCount: 0, acceptedCount: 0, blockers: [], createdAt: now, updatedAt: now,
    };
    core.apply(proj, "branch.created", { kind: "worker", id: String(body.createdBy ?? "unknown-worker") }, { branch });
    // mirror as a graph object so audit/graph navigation see it
    core.apply(proj, "object.created", { kind: "worker", id: String(body.createdBy ?? "unknown-worker") }, {
      object: {
        id, campaignId: proj.state.id, type: "branch", title: branch.thesis.slice(0, 120),
        content: { thesis: branch.thesis, methodTags: branch.methodTags }, tags: branch.methodTags,
        branchId: id, createdBy: String(body.createdBy ?? "unknown-worker"), createdAt: now, updatedAt: now,
      },
    });
    return { branch };
  }

  if (resource === "query" && method === "POST") {
    const proj = core.requireCampaign(String(body.campaignId));
    const type = body.type ? String(body.type) : undefined;
    const status = body.status ? String(body.status) : undefined;
    const branchId = body.branchId ? String(body.branchId) : undefined;
    const text = body.text ? String(body.text).toLowerCase() : undefined;
    const hits = [...proj.objects.values()].filter((o) => {
      if (type && o.type !== type) return false;
      if (status && o.epistemicStatus !== status) return false;
      if (branchId && o.branchId !== branchId) return false;
      if (text && !`${o.title} ${JSON.stringify(o.content)}`.toLowerCase().includes(text)) return false;
      return true;
    }).slice(0, Number(body.k ?? 20));
    return { objects: hits.map((o) => ({ id: o.id, type: o.type, title: o.title, status: o.epistemicStatus, branchId: o.branchId })) };
  }

  if (resource === "objects") {
    if (method === "POST" && !a) {
      const proj = core.requireCampaign(String(body.campaignId));
      const type = String(body.type ?? "");
      if (!type) throw new Error("object needs a type");
      const status = body.epistemicStatus ? String(body.epistemicStatus) : undefined;
      if (status) {
        if (!EPISTEMIC_STATUSES.includes(status as never)) throw new Error(`unknown epistemic status: ${status}`);
        if (VERIFIER_ONLY_STATUSES.includes(status as never)) {
          throw new Error(`workers cannot set status "${status}" — verification path only (invariant C)`);
        }
      }
      // v0.3 anti-duplication: soft-reject claims duplicating established knowledge
      if (type === "claim" && ctx.knowledgeLookup) {
        const dup = ctx.knowledgeLookup(String(body.title ?? ""));
        if (dup) {
          return { duplicate: true, establishedBy: dup.provenance, statement: dup.statement, hint: "already established — EXTEND or SUPERSEDE (bound beyond it, or different statement), don't duplicate" };
        }
      }
      const id = core.nextId(proj, type.split(".")[0]);
      const now = new Date().toISOString();
      const content = (body.content ?? {}) as Record<string, unknown>;
      if (body.bound) {
        const b = body.bound as { variable?: unknown; min?: unknown; max?: unknown };
        if (Number.isFinite(Number(b.min)) && Number.isFinite(Number(b.max))) {
          content.bound = { variable: String(b.variable ?? "n"), min: Number(b.min), max: Number(b.max) };
        }
      }
      const object = {
        id,
        campaignId: proj.state.id,
        type,
        title: String(body.title ?? id),
        content,
        epistemicStatus: status ?? defaultStatus(type),
        tags: (body.tags ?? []) as string[],
        branchId: body.branchId ? String(body.branchId) : undefined,
        createdBy: String(body.createdBy ?? "unknown-worker"),
        createdAt: now,
        updatedAt: now,
      };
      core.apply(proj, "object.created", { kind: "worker", id: object.createdBy }, { object }, { correlationId: body.branchId ? String(body.branchId) : undefined });
      if (type === "experiment") {
        core.apply(proj, "experiment.planned", { kind: "worker", id: object.createdBy }, { objectId: id }, { correlationId: id });
      }
      // optional edge attachments in one call: supports/contradicts/tests/derived_from → target
      if (body.relation && body.targetId) {
        const edgeId = core.nextId(proj, "edge");
        core.apply(proj, "edge.created", { kind: "worker", id: object.createdBy }, {
          edge: {
            id: edgeId, campaignId: proj.state.id, sourceId: id, targetId: String(body.targetId),
            relation: String(body.relation), properties: {}, createdBy: object.createdBy, createdAt: now,
          },
        });
      }
      return { object };
    }
    if (method === "GET" && a) {
      for (const proj of core.listCampaigns()) {
        const o = proj.objects.get(`object:${a}`) ?? proj.objects.get(a) ?? proj.objects.get(a.replace(/^[a-z]+_/, (m) => m));
        if (o) return o;
      }
      throw new Error(`object not found: ${a}`);
    }
    return null;
  }

  if (resource === "edges" && method === "POST") {
    const proj = core.requireCampaign(String(body.campaignId));
    const id = core.nextId(proj, "edge");
    const now = new Date().toISOString();
    const edge = {
      id, campaignId: proj.state.id,
      sourceId: String(body.sourceId), targetId: String(body.targetId),
      relation: String(body.relation ?? "related_to"),
      properties: (body.properties ?? {}) as Record<string, unknown>,
      createdBy: String(body.createdBy ?? "unknown-worker"), createdAt: now,
    };
    core.apply(proj, "edge.created", { kind: "worker", id: edge.createdBy }, { edge });
    return { edge };
  }

  if (resource === "graph" && a === "expand" && method === "GET") {
    const id = query.get("id");
    const depth = Math.min(Number(query.get("depth") ?? 1), 3);
    if (!id) throw new Error("graph/expand needs id");
    for (const proj of core.listCampaigns()) {
      if (!proj.objects.has(id) && !proj.edges.size) continue;
      const edges = [...proj.edges.values()].filter((e) => e.sourceId === id || e.targetId === id);
      if (edges.length === 0 && !proj.objects.has(id)) continue;
      const neighborIds = new Set<string>();
      const walk = (node: string, d: number) => {
        for (const e of proj.edges.values()) {
          const other = e.sourceId === node ? e.targetId : e.sourceId;
          if ((e.sourceId === node || e.targetId === node) && !neighborIds.has(other)) {
            neighborIds.add(other);
            if (d > 1) walk(other, d - 1);
          }
        }
      };
      walk(id, depth);
      return {
        center: proj.objects.get(id) ?? null,
        edges,
        neighbors: [...neighborIds].map((nid) => proj.objects.get(nid) ?? proj.branches.get(nid) ?? { id: nid, missing: true }),
      };
    }
    throw new Error(`object not found: ${id}`);
  }

  if (resource === "retrieve" && method === "POST") {
    const proj = core.requireCampaign(String(body.campaignId));
    return { items: retrieve(proj, (String(body.intent ?? "retrieve_all") as RetrievalIntent), String(body.query ?? ""), Number(body.k ?? 5)) };
  }

  if (resource === "tasks") {
    if (method === "POST" && a === "claim") {
      const proj = core.requireCampaign(String(body.campaignId));
      const waitSeconds = Math.min(Math.max(Number(body.waitSeconds ?? 0), 0), 180);
      const attempt = () =>
        (claimTask(core, proj, {
          workerAlias: String(body.workerAlias ?? "anonymous"),
          role: body.role ? String(body.role) : undefined,
          provider: body.provider ? String(body.provider) : undefined,
          model: body.model ? String(body.model) : undefined,
          mode: body.mode === "headless" ? "headless" : "interactive",
        }) ?? { task: null }) as { task: unknown; context?: unknown };
      let claimed = attempt() as { task: unknown; context?: unknown } | null;
      if (claimed && !claimed.task && waitSeconds > 0) {
        const started = Date.now();
        const deadline = started + waitSeconds * 1000;
        while (claimed && !claimed.task && Date.now() < deadline) {
          await new Promise<void>((resolve) => setTimeout(resolve, 1500));
          if (proj.state.status !== "running") break; // campaign left running — stop waiting
          claimed = attempt() as { task: unknown; context?: unknown } | null;
        }
        if (!claimed || !claimed.task) return { task: null, waitedMs: Date.now() - started };
        return { ...claimed, waitedMs: Date.now() - started };
      }
      if (!claimed || !claimed.task) return { task: null };
      return claimed;
    }
    if (method === "POST" && a && b === "result") {
      const proj = findCampaignOfTask(core, a, body.campaignId ? String(body.campaignId) : undefined);
      const outcome = submitResult(core, proj, taskIdIn(proj, a), {
        workerAlias: String(body.workerAlias ?? ""),
        status: (["success", "partial", "failure"].includes(String(body.status)) ? body.status : "failure") as "success" | "partial" | "failure",
        createdObjects: (body.createdObjects ?? []) as string[],
        createdArtifacts: (body.createdArtifacts ?? []) as string[],
        evidence: (body.evidence ?? []) as string[],
        openQuestions: (body.openQuestions ?? []) as string[],
        blockers: (body.blockers ?? []) as string[],
        summary: String(body.summary ?? ""),
        skillsUsed: (body.skillsUsed ?? []) as string[],
        minutesUsed: body.minutesUsed === undefined ? undefined : Number(body.minutesUsed),
        tokensEstimate: body.tokensEstimate === undefined ? undefined : Number(body.tokensEstimate),
        idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey) : undefined,
      });
      return outcome;
    }
    if (method === "POST" && a && b === "release") {
      const proj = findCampaignOfTask(core, a, body.campaignId ? String(body.campaignId) : undefined);
      const r = releaseTask(core, proj, taskIdIn(proj, a), String(body.workerAlias ?? ""), String(body.reason ?? "worker release"));
      return { result: r };
    }
    if (method === "POST" && a && b === "context") {
      const proj = findCampaignOfTask(core, a, query.get("campaignId") ?? undefined);
      const t = proj.tasks.get(taskIdIn(proj, a));
      if (!t) throw new Error("task not found");
      return { context: buildContextPack(proj, t) };
    }
    return null;
  }

  if (resource === "artifacts") {
    if (method === "POST" && !a) {
      const proj = core.requireCampaign(String(body.campaignId));
      const manifest = registerArtifact(core, proj, {
        workspacePath: body.workspacePath ? String(body.workspacePath) : undefined,
        contentBase64: body.contentBase64 ? String(body.contentBase64) : undefined,
        logicalName: String(body.logicalName ?? "artifact.bin"),
        mediaType: body.mediaType ? String(body.mediaType) : undefined,
        producer: String(body.producer ?? "unknown-worker"),
        branchId: body.branchId ? String(body.branchId) : undefined,
        parents: (body.parents ?? []) as string[],
      });
      return { artifact: manifest };
    }
    if (method === "GET" && a && !b) {
      const proj = findCampaignOfArtifact(core, a, query.get("campaignId") ?? undefined);
      return proj.artifacts.get(artifactIdIn(proj, a)) ?? (() => { throw new Error("artifact not found"); })();
    }
    if (method === "GET" && a && b === "content") {
      const proj = findCampaignOfArtifact(core, a, query.get("campaignId") ?? undefined);
      const buf = readArtifact(proj, artifactIdIn(proj, a));
      if (!buf) throw new Error("artifact content not found");
      return new RawResponse(200, { "content-type": "application/octet-stream" }, buf);
    }
    return null;
  }

  if (resource === "jobs") {
    if (method === "POST" && !a) {
      if (!ctx.jobs) throw new Error("job runner unavailable");
      const proj = core.requireCampaign(String(body.campaignId));
      const command = (body.command ?? []) as string[];
      if (command.length === 0 || typeof command[0] !== "string") throw new Error("job needs a command array");
      const job = ctx.jobs.create(proj, {
        name: String(body.name ?? "job"),
        command,
        cwd: body.cwd ? String(body.cwd) : undefined,
        wallSeconds: body.wallSeconds === undefined ? undefined : Math.min(Number(body.wallSeconds), 86400),
        createdBy: String(body.createdBy ?? "worker"),
      }) as { id: string; status: string; pid?: number };
      return { job };
    }
    if (method === "GET" && !a) {
      const proj = core.requireCampaign(String(query.get("campaignId") ?? ""));
      return [...proj.jobs.values()];
    }
    if (method === "GET" && a) {
      const ref = a.includes(":") ? a : `job:${a}`;
      for (const proj of core.listCampaigns()) {
        const j = proj.jobs.get(ref);
        if (j) return j;
      }
      throw new Error(`job not found: ${a}`);
    }
    return null;
  }

  if (resource === "novelty" && a === "search" && method === "POST") {
    const { noveltySearch } = await import("./noveltyProviders.js");
    const proj = core.requireCampaign(String(body.campaignId));
    const queryText = String(body.query ?? "");
    if (!queryText && !Array.isArray(body.terms)) throw new Error("novelty search needs query or terms");
    const out = await noveltySearch(core, proj, {
      query: queryText,
      terms: Array.isArray(body.terms) ? (body.terms as string[]) : undefined,
      providers: Array.isArray(body.providers) ? (body.providers as string[]) : undefined,
      auditId: body.auditId ? String(body.auditId) : undefined,
      maxPerQuery: body.maxPerQuery === undefined ? undefined : Number(body.maxPerQuery),
    });
    return out;
  }

  if (resource === "candidates" && a && b === "promote" && method === "POST") {
    const { promotionCheck, asCandidate, asFrontierSnapshot, isStale } = await import("@research-os/core");
    const cid = body.campaignId ? String(body.campaignId) : "";
    let proj = cid ? core.getCampaign(cid.includes(":") ? cid : `campaign:${cid}`) : undefined;
    let obj = proj?.objects.get(a.includes(":") ? a : `discovery_candidate:${a}`);
    if (!obj) {
      outer: for (const p of core.listCampaigns()) {
        for (const [id, o] of p.objects) {
          if (o.type === "discovery_candidate" && (id === a || id.endsWith(a))) { proj = p; obj = o; break outer; }
        }
      }
    }
    if (!obj || !proj) throw new Error(`not a discovery_candidate: ${a}`);
    const cand = asCandidate(obj);
    if (!cand) throw new Error(`not a discovery_candidate: ${a}`);
    const frontier = cand.frontierSnapshotId ? asFrontierSnapshot(proj.objects.get(cand.frontierSnapshotId)) : null;
    const fresh = frontier ? !isStale(frontier) : false;
    const check = promotionCheck(cand, fresh);
    if (!check.ok) {
      return { promoted: false, promotionStatus: check.promotionStatus, reasons: check.reasons };
    }
    core.apply(proj, "object.created", { kind: "auditor", id: "promotion-gate" }, {
      object: { ...obj!, content: { ...cand, promotionStatus: "human-review" }, updatedAt: new Date().toISOString() } as never,
    });
    return { promoted: true, promotionStatus: "human-review", reasons: ["correctness + novelty + frontier gates passed — awaiting HUMAN review"] };
  }

  if (resource === "verifiers" && method === "GET") {
    const modules = loadModules([ctx.modulesDir]);
    const campaignId = query.get("campaignId");
    let list = modules;
    if (campaignId) {
      const proj = core.requireCampaign(campaignId);
      const ids = new Set(proj.state.modules);
      list = modules.filter((m) => ids.has(m.manifest.id));
    }
    return {
      verifiers: list.flatMap((m) => m.verifiers.map((v) => ({ id: v.id, label: v.label, description: v.description, inputs: v.inputs }))),
      capabilities: Object.fromEntries(list.filter((m) => m.capabilities).map((m) => [m.manifest.id, m.capabilities])),
    };
  }
  if (resource === "modules" && a && b === "capabilities" && method === "GET") {
    const modules = loadModules([ctx.modulesDir]);
    const m = modules.find((x) => x.manifest.id === a);
    if (!m) throw new Error(`unknown module: ${a}`);
    return { moduleId: m.manifest.id, capabilities: m.capabilities ?? null };
  }

  if (resource === "verifications") {
    if (method === "POST" && !a) {
      const proj = core.requireCampaign(String(body.campaignId));
      const modules = loadModules([ctx.modulesDir]);
      const verifier = verifierById(modules, String(body.verifierId));
      if (!verifier) throw new Error(`unknown verifier: ${String(body.verifierId)}`);
      if (!verifiersForCampaign(modules, proj.state.modules).some((v) => v.id === verifier.id)) {
        throw new Error(`verifier ${verifier.id} is not part of campaign modules ${proj.state.modules.join(", ")}`);
      }
      const outcome = await runVerification(core, proj, verifier, {
        targetId: String(body.targetId),
        requestedBy: String(body.requestedBy ?? "unknown-worker"),
        input: (body.input ?? {}) as Record<string, unknown>,
      });
      void ctx.mesh.broadcast(campaignRoom(proj.state.id), `Verification ${outcome.verification.status.toUpperCase()} — ${verifier.id} on ${body.targetId} (log: ${outcome.artifactRef})`);
      return outcome;
    }
    if (method === "GET" && a) {
      for (const proj of core.listCampaigns()) {
        const v = proj.verifications.get(`verification:${a}`) ?? proj.verifications.get(a);
        if (v) return v;
      }
      throw new Error("verification not found");
    }
    return null;
  }

  if (resource === "skills" && method === "POST") {
    const proj = core.requireCampaign(String(body.campaignId));
    const skill = proposeSkill(core, proj, {
      name: String(body.name ?? "unnamed-skill"),
      activation: (body.activation ?? []) as string[],
      procedure: (body.procedure ?? []) as string[],
      termination: (body.termination ?? []) as string[],
      warnings: (body.warnings ?? []) as string[],
      evidenceRefs: (body.evidenceRefs ?? []) as string[],
      compatibleRoles: (body.compatibleRoles ?? []) as string[],
      createdBy: String(body.createdBy ?? "unknown-worker"),
    });
    return { skill };
  }

  if (resource === "mesh" && a === "status" && method === "GET") {
    return ctx.mesh.status();
  }

  if (resource === "context" && method === "GET") {
    // worker context refresh: latest task of this worker
    const alias = query.get("worker");
    for (const proj of core.listCampaigns()) {
      const tasks = [...proj.tasks.values()].filter((t) => t.lease?.holder === alias && (t.status === "leased" || t.status === "running"));
      if (tasks.length > 0) return { context: buildContextPack(proj, tasks[0]) };
    }
    return { context: null };
  }

  return null;
}

// ---- helpers ----

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.method === "GET" || req.method === "HEAD") return Promise.resolve({});
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function defaultStatus(type: string): string | undefined {
  if (type === "claim" || type === "hypothesis") return "speculative";
  if (type === "evidence") return undefined;
  if (type === "source") return "source_supported";
  if (type === "observation" || type === "question" || type === "note" || type === "branch" || type === "decision") return undefined;
  return "unverified";
}

function campaignSummary(proj: CampaignProjection): unknown {
  const s = proj.state;
  const tasksByStatus: Record<string, number> = {};
  for (const t of proj.tasks.values()) tasksByStatus[t.status] = (tasksByStatus[t.status] ?? 0) + 1;
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    round: s.currentRound,
    modules: s.modules,
    objective: { statement: s.objective.statement, version: s.objective.version, hash: s.objective.contentHash },
    counts: {
      branches: proj.branches.size,
      objects: proj.objects.size,
      edges: proj.edges.size,
      tasks: proj.tasks.size,
      verifications: proj.verifications.size,
      memories: proj.memories.size,
      skills: proj.skills.size,
      artifacts: proj.artifacts.size,
      queued: queuedTasks(proj).length,
      tasksByStatus,
    },
    budgets: s.budgets,
    workspace: proj.workspaceDir,
    room: campaignRoom(s.id),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function findCampaignOfTask(core: ResearchCore, taskRef: string, campaignId?: string): CampaignProjection {
  const ref = taskRef.includes(":") ? taskRef : `task:${taskRef}`;
  if (campaignId) {
    const scoped = core.getCampaign(campaignId.includes(":") ? campaignId : `campaign:${campaignId}`);
    if (scoped?.tasks.has(ref)) return scoped;
  }
  for (const proj of core.listCampaigns()) {
    if (proj.tasks.has(ref)) return proj;
  }
  throw new Error(`task not found: ${taskRef}`);
}

function taskIdIn(proj: CampaignProjection, taskRef: string): string {
  const ref = taskRef.includes(":") ? taskRef : `task:${taskRef}`;
  if (proj.tasks.has(ref)) return ref;
  throw new Error(`task not in campaign: ${taskRef}`);
}

function findCampaignOfArtifact(core: ResearchCore, ref: string, campaignId?: string): CampaignProjection {
  const full = ref.includes(":") ? ref : `artifact:${ref}`;
  if (campaignId) {
    const scoped = core.getCampaign(campaignId.includes(":") ? campaignId : `campaign:${campaignId}`);
    if (scoped?.artifacts.has(full)) return scoped;
  }
  for (const proj of core.listCampaigns()) {
    if (proj.artifacts.has(full)) return proj;
  }
  throw new Error(`artifact not found: ${ref}`);
}

function artifactIdIn(proj: CampaignProjection, ref: string): string {
  const full = ref.includes(":") ? ref : `artifact:${ref}`;
  if (proj.artifacts.has(full)) return full;
  throw new Error(`artifact not in campaign: ${ref}`);
}

export function normalizeSpec(spec: CampaignSpec): CampaignSpec {
  const workers = spec.workers ?? { autoSpawn: 0, leaseSeconds: 1200 };
  // headless campaigns: leases only serve crash detection (maxRunMinutes protects long runs)
  if (workers.autoSpawn > 0 && workers.leaseSeconds > 1500) workers.leaseSeconds = 1500;
  return {
    ...spec,
    modules: spec.modules ?? [],
    models: spec.models ?? { defaultPool: [{ id: "zai-glm-5.3", provider: "zai", model: "glm-5.3", runtime: "pi", thinkingLevel: "max", tags: ["default"] }] },
    search: spec.search ?? { policy: "round-robin", blindGenerators: 3, maxBranches: 8 },
    budgets: spec.budgets ?? { maxAgentRuns: 40, maxTasks: 60, maxRounds: 4, maxExperiments: 12, wallClockMinutes: 90, maxTokensEstimate: 50_000_000 },
    autonomy: spec.autonomy ?? { level: "L3", humanApprovalRequiredFor: [] },
    workers,
    stop: spec.stop ?? { onSuccess: true, onBudgetExhausted: true, noProgressRounds: 3 },
    verification: spec.verification ?? { requireIndependentAudit: true },
  };
}

export function sseStream(core: ResearchCore, campaignId: string | null, res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(":ok\n\n");
  const unsub = core.subscribe((cid, event: ResearchEvent) => {
    if (campaignId && cid !== campaignId) return;
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const ping = setInterval(() => res.write(":ping\n\n"), 15_000);
  res.on("close", () => {
    unsub();
    clearInterval(ping);
  });
}
