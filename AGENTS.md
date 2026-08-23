# ResearchOS — agent guide (root)

You are working on **ResearchOS**, a modular autonomous research platform. When docs disagree with reality, the code wins; when you change behavior, update the nearest `AGENTS.md` too.

## Agent doc network

Only THIS file auto-loads in Pi (cwd + ancestors). Read the others on demand:

| File | Covers |
|---|---|
| `packages/contracts/AGENTS.md` | Shared types, ids, events — the no-Pi-imports rule |
| `packages/core/AGENTS.md` | Event sourcing, scheduler, audit, verifiers, adapters |
| `apps/researchd/AGENTS.md` | HTTP API routes, daemon wiring, env vars |
| `apps/cli/AGENTS.md` | `research` CLI |
| `pi/research-os-pi/AGENTS.md` | The Pi worker extension (`research_*` tools) |
| `modules/AGENTS.md` | **The domain-module norm** — how to write/extend modules |
| `modules/mathematics/AGENTS.md` | Math verifiers, exact library, predicates |
| `modules/mathematics-lite/AGENTS.md` | Minimal reference module |
| `examples/AGENTS.md` | Campaign YAML norm |
| `examples/open-problems/AGENTS.md` | Open-problem queue rules (one at a time) |
| `bin/AGENTS.md` | Ops runbook (tmux, headless, restart, crash/resume) |

## 30-second architecture

```
researchd (node, HTTP :8787)        one process, logical services
 ├ event store    JSONL per campaign + deterministic replay at boot (truth)
 ├ scheduler      rounds: ground→generate→critique→test→consolidate
 ├ tasks/leases   claim→lease→running→submitted→audit→accepted/rejected
 ├ audit          rule-based; rejects unproven verifier-only statuses
 ├ verifiers      exec verifiers from modules (sandbox dir, timeout, exit code)
 ├ artifacts      content-addressed (sha256), immutable
 ├ memory/retrieval, ContextPack builder, reports
 └ mesh client    minimal mesh.v1 → same pi-mesh broker as all Pi agents (transport only)

Pi workers (ZAI GLM-5.3, thinking max — the ONLY provider, per user constraint)
 headless: spawned by researchd (`pi -p` in campaign workspace, fresh context)
 interactive: tmux windows; workspace scaffold gives them .pi/ extension + skills
```

Domain knowledge (math, future domains) lives ONLY in `modules/` — the core has none.

## Non-negotiable invariants (enforced in code — keep them true)

1. **C**: only a verifier run can set `verified`/`falsified`/`reproduced`. The server rejects workers setting them; the audit rejects them without a matching `verification` record with `appliedTransitions`.
2. **A/B**: durable state is the event log (replayable); Pi sessions and mesh messages are never authoritative.
3. **G**: `packages/contracts` and `packages/core` contain ZERO Pi imports. Pi lives in `pi/research-os-pi` (tools), `packages/core/src/runtime/pi.ts` (spawn adapter) and `mesh/` (transport) only.
4. **F**: domain logic enters via modules; core never interprets module content (prompts are opaque strings).
5. Events: every mutation goes through `core.apply()`; `applyEvent()` must deterministically handle EVERY event type (replay is the crash/resume story).
6. Negative results are first-class: failures, counterexamples and rejection reasons are stored, never deleted silently.

## Commands

```bash
pnpm install && pnpm -r build     # build all
pnpm test                         # engine tests, NO LLM (e2e + math module)
bin/research-queue.sh             # ★ autonomous pipeline: one problem at a time, forever
bin/research-tmux.sh [yaml] [n]   # interactive bring-up (daemon+operator+n workers)
bin/research-headless.sh [yaml]   # autonomous run, autoSpawn workers
bin/research-open-problems.sh [--only N]   # one-shot sequential runner (no watchdog)
bin/research-down.sh              # stop daemon + workers (state survives)
```

The **queue supervisor** (`apps/queue`, tmux window `queue`) is the long-run mode:
it adopts whatever campaign is running, waits for terminal state, exports the report
to `workspaces/reports/`, then starts the next YAML from `examples/open-problems/`
(sorted). It respawns researchd on crash (event replay restores everything) and
records progress in `workspaces/queue.json`. New problems = drop a YAML in the
queue dir (or edit `catalog.json` + regenerate). Success criteria are OR semantics:
the first satisfied criterion completes the campaign.

Daemon env: `RESEARCH_PORT=8787 RESEARCH_HOME=<repo>/workspaces` (also `RESEARCH_MODULES`, `RESEARCH_PI_PACKAGE`, `RESEARCH_TICK_MS`, `RESEARCH_MESH_ALIAS`). CLI env: `RESEARCH_URL`.

## Gotchas learned the hard way

- **Readable ids (`task:t_1`, `artifact:a_2`) restart at 1 in EVERY campaign.** Any route resolving an id by ref MUST be scoped by `campaignId` (task result/release/context and artifact routes already are — keep it that way for new routes). Both task routes and artifact routes are scoped — keep it that way for new routes.
- `apps/researchd/src/main.ts` resolves the repo root as `__dirname/../../..` (dist → researchd → apps → root). If you move the file, fix the path.
- `pnpm test` needs the test glob `dist/test/*.test.js` (trailing-slash dirs confuse `node --test`).
- `workspaces/` is runtime state (gitignored except its AGENTS.md). Never hand-edit `state/events.jsonl`; replay is read-only.
- Test Pi extensions from a NEUTRAL directory (`pi -e <abs path>`), never from a repo that auto-loads its own `.pi/`.

## Extension points (the whole point of this project)

- **Add context** → files in campaign workspaces (`AGENTS.md`, `.pi/skills/<name>/SKILL.md`); module seed skills land there automatically at campaign creation.
- **Add tools** → `pi/research-os-pi/extension/index.ts`; state-mutating tools need a matching researchd route.
- **Add verifiers/domain** → a directory under `modules/` (see `modules/AGENTS.md`). No core changes.
- **Add campaigns** → `examples/` YAML (see `examples/AGENTS.md`).

## Current live deployment

- Single provider: **ZAI GLM-5.3, thinking max** (subscription constraint). `ModelProfile` pools exist but heterogeneous routing is untested.
- A long-running tmux deployment may exist (daemon / operator / worker / queue windows); check `tmux ls` and `research doctor` before assuming.
- Epistemic ladder used everywhere: `speculative → unverified → empirically_supported / source_supported → verified | falsified` (verified/falsified = verifier-only).
