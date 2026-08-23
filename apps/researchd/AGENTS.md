# apps/researchd — the daemon (HTTP API + scheduler loop)

Zero-dependency Node HTTP server (`server.ts`) + wiring (`main.ts`). One process, logical services (§2.10 monolith first).

## Env vars (`main.ts`)

`RESEARCH_PORT` (8787) · `RESEARCH_HOME` (repo/workspaces) · `RESEARCH_MODULES` (repo/modules) · `RESEARCH_PI_PACKAGE` (repo/pi/research-os-pi) · `RESEARCH_TICK_MS` (3000) · `RESEARCH_MESH_ALIAS` (researchd).

ROOT = `__dirname/../../..` (dist → researchd → apps → repo root). Moving `main.ts`? Fix the path.

## Routes (v1)

```
GET  /v1/health                     GET /v1/mesh/status
GET  /v1/stream                     (SSE, optional ?campaign=)
POST /v1/campaigns                  {spec}           → creates + scaffolds workspace
GET  /v1/campaigns[/:id]            POST /:id/start|pause|resume|stop
GET  /:id/report | /:id/events | /:id/branches | /:id/workers | /:id/tasks
POST /v1/branches                   {campaignId, thesis, methodTags, …}
POST /v1/objects                    {campaignId, type, …, epistemicStatus?}  ← rejects VERIFIER_ONLY
GET  /v1/objects/:ref               POST /v1/edges
GET  /v1/graph/expand?id=&depth=
POST /v1/query                      {campaignId, type|status|branchId|text}
POST /v1/retrieve                   {campaignId, intent, query}
POST /v1/tasks/claim                {campaignId, workerAlias, role?}
POST /v1/tasks/:ref/result          {campaignId!, workerAlias, …}   ← idempotencyKey supported
POST /v1/tasks/:ref/release | /:ref/context
POST /v1/artifacts                  {campaignId, workspacePath|contentBase64, logicalName}
GET  /v1/artifacts/:ref[?campaignId=]  and /:ref/content[?campaignId=]
GET  /v1/verifiers[?campaignId=]    POST /v1/verifications {campaignId, targetId, verifierId, input}
POST /v1/skills                     GET /v1/context?worker=
```

**RULE: any route that resolves a readable ref (`task:t_1`, `artifact:a_2`, …) MUST be scoped with `campaignId`** — ids restart at 1 in every campaign; unscoped lookup hits the wrong campaign (fixed twice: `1585587`, `c27c1e4`).

## How to add a route

1. Add a case in `route()` (server.ts) with `method + resource + subresource`.
2. Mutations go through `core.apply` (via core services) — never touch projections directly.
3. Worker-callable routes must validate: worker-posed `epistemicStatus` ∉ `VERIFIER_ONLY_STATUSES`; verifier runs check module membership (`verifiersForCampaign`).
4. Return JSON; raw file bodies via `RawResponse`.
5. Add/extend an engine test in `src/test/` (no LLM).

## Testing

`pnpm test` runs `node --test dist/test/*.test.js` — e2e campaign lifecycle + math module verifier semantics, all without an LLM (scripted fake workers over real HTTP).
