# packages/contracts — shared types (zero dependencies)

The vocabulary of ResearchOS: ids, events, research objects, tasks, verification, memory, modules, adapter interfaces. Every other package imports from here; this package imports from NOBODY.

## Rules

1. **No Pi imports. Ever.** (invariant G — the research model must stay harness-independent). Runtime and transport are described as INTERFACES (`agents.ts`), implemented elsewhere.
2. **No runtime dependencies.** Helpers here are tiny and dependency-free (`guards.ts`: `isRecord`, `str`, `canonicalJson`…).
3. Types are TypeScript-first. There is no zod; validate at the edges (researchd routes, module loader) with the guards.

## File map

- `ids.ts` — readable id scheme `<type>:<prefix>_<seq>` (e.g. `hypothesis:h_92`), `makeId/parseId`. Sequences are PER CAMPAIGN — ids collide across campaigns by design (see root gotchas).
- `events.ts` — `ResearchEvent` envelope + `EVENT_TYPES`. Adding an event type? Add it here AND to `applyEvent` in `packages/core/src/core.ts` (replay must handle it or ignore it deliberately).
- `objects.ts` — `ResearchObject`, `EPISTEMIC_STATUSES`, `VERIFIER_ONLY_STATUSES` (`verified`, `falsified`, `reproduced`), edges, branches.
- `campaign.ts` — `CampaignSpec` / `CampaignState` / budgets / objective (`contentHash` = anti-drift hash injected into every ContextPack). `modulePrompts` carries domain guidance replay-safely.
- `tasks.ts` — `TaskSpec`, `ResultEnvelope`, leases.
- `verification.ts` — `ExecVerifierDefinition` (the module verifier JSON shape), `VerificationRecord`. `moduleDir`/`moduleId` are loader-assigned, not authored in module JSON.
- `memory.ts`, `context.ts` — memory items, skills, `ContextPack`.
- `module.ts` — `DomainModuleManifest` (what a module can declare), `WorkspaceConfig`.
- `agents.ts` — `AgentRuntimeAdapter` / `AgentTransportAdapter` interfaces + run records.

## Conventions

- Epistemic status changes are union-typed strings; keep `VERIFIER_ONLY_STATUSES` in sync with anything new.
- `CampaignSpec` fields the CLI/scaffold normalize: `normalizeSpec()` in `apps/researchd/src/server.ts` fills defaults — contracts stay the source of truth for shapes.
- Anything persisted in an event payload must survive JSON round-trips (no Dates, no Maps).
