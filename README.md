# ResearchOS

**A modular, autonomous research platform.** Agents propose; exact verifiers decide; durable state remembers.

> LLMs are replaceable reasoning engines. ResearchOS is the persistent researcher.

ResearchOS runs long-lived research campaigns in which multiple agents explore
independent branches, attack each other's claims, run exact computational
experiments — and in which **nothing becomes `verified` or `falsified` except
through a deterministic verifier**. Every claim carries the exact domain it was
proven on; every failure is kept as first-class memory; every campaign can be
killed and resumed without losing anything.

```
            ┌──────────────────────── researchd (one process) ────────────────────────┐
            │  event store (JSONL, deterministic replay)   module registry            │
            │  round scheduler  ground→generate→critique→test→consolidate              │
            │  task leases · rule-based audit · budgets · QD archive · paradigm-break  │
            │  exec verifiers (sandboxed, exit-code decides) · content-addressed      │
            │  artifacts · cross-campaign memory & skills · reports · frontier         │
            └───────────────┬─────────────────────────────────────────┬───────────────┘
                            │ HTTP API + SSE                          │ mesh.v1 (transport only)
                   ┌────────┴────────┐                       ┌────────┴────────┐
                   │  Pi workers     │◄────── broker ──────►│  more workers   │
                   │  (any provider) │      (pi-mesh)        │  (any machine)  │
                   └─────────────────┘                       └─────────────────┘
```

## Why it is different

- **Epistemic integrity by construction.** Workers cannot self-promote a claim.
  Verifier runs are the only path to `verified`/`falsified`, and since V0.2 every
  verified bounded claim carries the *exact* domain the verifier covered — a
  claim announcing `[1, 20000]` verified only on `[1, 998]` is refused or flagged.
- **External state is authoritative.** Campaigns live in an append-only event
  log; agents are disposable execution contexts. Kill -9 the whole stack, replay
  on restart, continue.
- **A real lab, not a chat swarm.** Blind independent generation → adversarial
  critique → exact experiments → consolidation, with cycle gates that prevent a
  single overachieving scout from closing the campaign before the lab ran.
- **Learning without fine-tuning.** Negative results are exported cross-campaign;
  procedural skills are cited by workers and promoted on repeated use.
- **Domains are modules.** The core has zero mathematics in it. The
  `mathematics` module brings exact-arithmetic verifiers, roles, diversity
  descriptors and seed skills — add your own domain without touching the core.

## Quick start

Requirements: Node ≥ 20, Python ≥ 3.11 (with `sympy` for symbolic checks), tmux
optional but recommended. A Pi-compatible agent runtime with one provider is
needed for live workers (the engine itself is runtime-agnostic).

```bash
pnpm install && pnpm -r build     # build everything
pnpm test                         # 22 engine tests — full pipeline, NO LLM needed

# autonomous queue: unsolved math problems, ONE campaign at a time, forever
bin/research-queue.sh                       # supervisor in tmux (watchdog, reports, chaining)

# or a single interactive campaign
bin/research-tmux.sh examples/campaigns/euler-prime-interactive.yaml 2

# inspect
node apps/cli/dist/main.js doctor           # researchd + mesh health
node apps/cli/dist/main.js queue            # queue ledger + live campaigns
node apps/cli/dist/main.js campaign status c_1
node apps/cli/dist/main.js campaign frontier c_1    # live research frontier
node apps/cli/dist/main.js campaign report c_1      # evidence-backed markdown

bin/research-down.sh                        # stop everything (state survives)
```

The engine tests run the *entire* pipeline — campaign lifecycle, leases, audit,
verifiers, gates, memory, crash/replay — with scripted workers over real HTTP:
no API keys required.

## The mathematics module

Deterministic verifiers, sandboxed by the core:

| Verifier | Meaning |
|---|---|
| `exhaustive-finite` | complete finite domain (≤ 5M cases) ⇒ **verified** bounded claim |
| `exact-counterexample` | one exact witness ⇒ **falsified** |
| `exact-point` | one exact assignment ⇒ **verified** |
| `certificate-check` | witness + worker `verify()` + exact cross-check + structural constraints (allDistinct, tupleAllPrime) — the runner decides the exit code, cheating scripts are rejected |
| `numerical-evidence` | partial range ⇒ `empirically_supported` only, never verified |
| `symbolic-identity` | sympy exact simplification |
| `lean-kernel` | Lean 4 compile check, `sorry`/`admit`/`axiom` rejected (requires elan; errors cleanly without it) |

Exact library (deterministic): primality (Miller-Rabin < 3.3e24), `next_prime_gap`,
`prime_pi`, `goldbach_even`, `legendre_gap`, `rad`, `abc_quality_gt` (exact
integer-power comparison — no floats), `waring_min_s`, `divisor_sum`,
`sigma_ratio_*`, `factorial`, `primorial`, `gilbreath_rows_ok`, Lucas-Lehmer
Mersenne test, memoized Collatz. Capabilities are served machine-readable
(`GET /v1/modules/mathematics/capabilities`) so agents never read module sources.

## Open-problem queue

`examples/open-problems/` ships **54 campaigns generated from the list of famous
unsolved problems** (Collatz, Goldbach, Legendre, Brocard, Gilbreath, odd perfect
numbers, Polignac, twin primes, abc, Waring, taxicab(5), Erdős-type graph and
Ramsey problems, millennium problems as honest exploration campaigns…), each
framed for *verified bounded progress*: push the largest exactly-verified bound,
falsify auxiliary conjectures, certificate any witness found — never "prove the
conjecture". The catalog (`catalog.json`) is the source of truth;

```bash
node bin/generate-open-problem-campaigns.mjs           # regenerate (idempotent)
node bin/generate-open-problem-campaigns.mjs --check   # CI drift guard
```

## Extending

- **Add a domain module** — declarative directory: manifest + exec verifiers +
  seed skills. See `modules/AGENTS.md` (the module norm) and
  `modules/mathematics/` as the reference implementation.
- **Add tools** for agents — `pi/research-os-pi/` (the `research_*` surface) or
  any runtime package.
- **Add campaigns** — YAML in `examples/` (see `examples/AGENTS.md`).
- **Add providers** — campaigns declare model pools; the core is provider-agnostic.

Every directory owns an `AGENTS.md` explaining its rules — start with the root one.

## Repository layout

```
packages/contracts   shared types — zero deps, zero Pi imports (harness-independent)
packages/core        event store + replay, scheduler, leases, audit, verifiers,
                     artifacts, memory, ContextPack, reports, mesh client, runtime adapter
apps/researchd       the daemon: HTTP API + SSE + scheduler loop + module loader
apps/cli             the `research` CLI
apps/queue           the queue supervisor (one problem at a time, watchdog, reports)
pi/research-os-pi    Pi worker extension (research_* tools) + worker skill
modules/mathematics  the mathematics domain module (verifiers, skills, prompts)
modules/mathematics-lite  minimal reference module
examples/            campaign YAMLs + the open-problem queue + catalog
bin/                 bring-up, queue, headless, open-problems runner, integrity sweeps
```

## Status

v0.2–v0.8 feature set implemented and battle-tested by an autonomous queue run
over dozens of campaigns (event-sourced durability survived real crashes; bound
integrity regression tests encode incidents found during that run). Known
limits: single-machine deployment, keyword retrieval (no embeddings yet),
token accounting depends on provider-reported usage.

## License

MIT — see [LICENSE](LICENSE).

## v0.2 — the novelty layer

Beyond solving: **discovering**. The mathematics module now runs a discovery loop —
map the public *frontier* (dated, sourced snapshots; records go stale in 24h), derive the
exact *improvement predicate*, hunt *certificates* with durable search jobs
(`hunt.py`: van der Waerden colorings, Ramsey graphs, circulant symmetry-reduced spaces),
verify them independently, then **adversarially audit novelty** (OEIS values+definitions,
OpenAlex/arXiv/Crossref literature) before a promotion gate whose terminal state is always
*human review*. Correctness and novelty are never collapsed into one score, and a failed
search is recorded as scoped negative memory — never as nonexistence.
