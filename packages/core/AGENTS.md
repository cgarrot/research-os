# packages/core — the research core (event-sourced truth + orchestration)

One rule above all: **every mutation is an event**; projections are rebuilt by deterministic replay. If you add behavior, ask "what event represents this, and does `applyEvent` handle it on replay?"

## File map

| File | Role |
|---|---|
| `core.ts` | `ResearchCore` aggregate + `applyEvent` (the reducer). Single write path: `core.apply(proj, type, actor, payload)` appends AND applies. `subscribe()` feeds SSE. |
| `eventStore.ts` | JSONL append-only log per campaign (`state/events.jsonl`). Torn tail lines tolerated. |
| `scheduler.ts` | Round engine: `PHASES = ground→generate→critique→test→consolidate`. Opens the next phase when the current one settles (all tasks terminal); `round.closed` tracks no-progress; stop conditions (success criteria / budgets / rounds / stagnation); `maybeSpawnWorkers` launches headless runs (`autoSpawn`). Module prompts are appended to task goals here. |
| `taskService.ts` | claim/lease/expire/requeue (max 3 attempts), `submitResult` → audit → accept/reject, idempotency keys. |
| `audit.ts` | Rule-based auditor. Enforces invariant C: verifier-only statuses allowed ONLY with a matching verification `appliedTransitions` record. Evidence entries may be prose; ref-shaped entries must exist. |
| `verifierService.ts` | Runs exec verifiers in `state/sandbox/<id>/`, registers the log as an artifact, applies `onPass`/`onFail` claim transitions (the ONLY path to verified/falsified), creates evidence objects + graph edges. Timeout → status `error` (no transition). |
| `artifacts.ts` | Content-addressed store `state/artifacts/<2hex>/<sha256>`, immutable, deduped by hash. |
| `memoryService.ts` | Episodic/negative memory consolidation, skill candidates (never auto-activated), intent-based retrieval (`retrieve_failures`, `retrieve_skills`, …) with token-overlap scoring. |
| `contextBuilder.ts` | `ContextPack` assembly + the worker contract text (§41). Blind-mode notice in generate phase; module guidance included. |
| `campaignService.ts` | Campaign create/start/pause/stop, workspace scaffolding (`.pi/` copy from `pi/research-os-pi` + module seed skills), success-criteria evaluation. |
| `reportService.ts` | Markdown report from structured state only (never model memory). |
| `moduleLoader.ts` | Declarative module discovery (see `modules/AGENTS.md`). Verifier ids = `<moduleId>:<name>`. |
| `mesh/` | Minimal `mesh.v1` NDJSON client + `PiMeshTransportAdapter`. Broker socket: `$TMPDIR/mesh-<uid>/broker.sock` (override `MESH_RUNTIME_DIR`). Transport ONLY — never state (invariant B). Rooms: `campaign.c-<n>` (dots/dashes only). |
| `runtime/pi.ts` | `PiProcessAdapter`: spawns headless `pi -p --provider zai --model glm-5.3 --thinking max` in the campaign workspace with `RESEARCH_URL/WORKER_ALIAS/CAMPAIGN` env, bootstrap prompt on stdin, hard kill after `maxRunMinutes` (default 25). |

## Adding a new event type

1. Add to `EVENT_TYPES` (`packages/contracts`).
2. Add a case in `applyEvent` that mutates the projection deterministically (unknown types are ignored on replay — forward compatible, but YOUR type must be handled).
3. Emit only via `core.apply`. Never mutate projection fields directly outside the reducer.

## Enforced epistemics

- `VERIFIER_ONLY_STATUSES` can only be set by `verifierService` transitions. Server routes (`apps/researchd`) also reject workers submitting them.
- Success criterion `claim_status:<status>` only counts if a verification record shows the transition (see `campaignService.completedCriteria`).

## Tests

Engine tests (no LLM) live in `apps/researchd/src/test/` — they drive the core over real HTTP. When you touch the core, run `pnpm test`; add an engine test for new semantics.
