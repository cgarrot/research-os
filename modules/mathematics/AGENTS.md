# modules/mathematics — the mathematics domain module

Vision: `MATHEMATICS_MODULE_SPEC.md` (§7 epistemic grades M0–M6/FALSIFIED_EXACT). v0.1 maps them onto core statuses: `verified` = M4 (exact finite) or M5-lite (symbolic identity), `falsified` = FALSIFIED_EXACT, `empirically_supported` = M2, `source_supported` = M3. Lean (M5/M6) arrives as an extra verifier when a toolchain is installed — it is deliberately optional.

## Verifier suite

| id (prefix `mathematics:`) | semantics | onPass → | onFail → |
|---|---|---|---|
| `exhaustive-finite` | predicate over the COMPLETE cartesian product of declared ranges (≤5M cases) — proof of the bounded statement | `verified` | `falsified` (prints the counterexample) |
| `exact-counterexample` | ONE exact assignment; **the predicate describes what FAILS at the witness** (i.e. the negation of the claim) | `falsified` | `inconclusive` |
| `exact-point` | one exact assignment, predicate holds | `verified` | `inconclusive` |
| `numerical-evidence` | PARTIAL range only — never a proof | `empirically_supported` | `falsified` |
| `symbolic-identity` | sympy `simplify(l−r) == 0` (proof-grade for polynomial/rational) | `verified` | `inconclusive` |

The counterexample-vs-point polarity is the #1 usage trap: to kill "∀n P(n)" you pass the witness + the FAILING predicate (e.g. `not_prime`, `collatz_steps_greater_than:100`).

## Exact library (`verifiers/check.py`)

Expression functions (sanitized eval, integers only): `abs min max gcd isqrt factorial divisor_sum prime_pi goldbach_count gilbreath_rows_ok collatz_steps collatz_max`.

Predicates: `prime not_prime even odd square not_square` · `equals:K not_equals:K divisible_by:K not_divisible_by:K` · `greater_than:K less_than:K geq:K leq:K` · `collatz_terminates collatz_steps_less_than:K collatz_steps_greater_than:K collatz_max_value_less_than:K`.

Caps (guards, not hardware limits): exhaustive ≤ 5,000,000 cases (`maxCases` default 3M) · `factorial` n ≤ 20,000 · `gilbreath_rows_ok` k ≤ 5,000 · collatz trajectory ≤ 10⁷ steps. Perf: collatz steps are memoized (1M numbers ≈ 0.7 s); the prime sieve caches to 1M+.

## Core philosophy pushed by the prompts/skills

- Bounded verification is the standard move on open problems: state "P(n) for all n ∈ [1,K]" and get it VERIFIED. Never let a claim say "∀n" when K was checked.
- Falsify before proving; small cases first; exact arithmetic only (floats = exploration, never evidence).
- Representations: computational / modular / extremal / structural / probabilistic / representation-change / inductive-invariant / algebraic-identity (the diversity descriptors).

## Extending

- New predicate/function → `check.py` (+ keep the docstring list in sync); add engine-test coverage in `apps/researchd/src/test/math.test.ts`.
- New verifier family (e.g. Lean) → new json + script following `modules/AGENTS.md`; keep the exit-code contract.
- Phase guidance lives in `research.module.json` `prompts` — edit + restart researchd.

## Proven live

Campaign `c_5` (Syracuse/Collatz, GLM-5.3): `verified` for n ∈ [1, 5,000,000] (5M/5M cases), one auxiliary conjecture `falsified` exactly, a sharpened variant correctly left `empirically_supported`. Report: `workspaces/report-campaign:c_5.md`.

## Novelty layer v0.2 (spec: MATHEMATICS_NOVELTY_LAYER_SPEC)

Discovery loop: MAP FRONTIER → DEFINE NEW → SEARCH → VERIFY → DISPROVE NOVELTY → LEARN.

- **Frontier snapshots** (`frontier_snapshot` objects via `research_frontier_snapshot`): dated, sourced public frontier + EXACT improvement predicate. Records stale in **24h** — refresh before ANY promotion. Same-class source disagreement ⇒ `conflict` ⇒ resolution task before hunting. **Never hunt from a hand-written number.**
- **Durable jobs** (`research_job_create` / `research_job_status`, researchd `/v1/jobs`): long compute detached from agent turns, stdout → immutable artifact, wall-clock kill, replay marks `interrupted`. `hunt.py` (python/) = search workbench: vdw / ramsey / ramsey-circulant problems, strategies random-restart|hill|sa|tabu|evo, checkpoints+resume, NDJSON PROGRESS/RESULT, final `validate()` independent of search.
- **Novelty audits** (`research_novelty_search` → researchd providers OEIS/arXiv/OpenAlex/Crossref, S2 fail-soft): every hit stored as `novelty_evidence`. Statuses conservative; quick mode never yields `likely-new-after-audited-search`; provider outage never manufactures novelty; sequences require OEIS coverage (values on several prefixes AND definition).
- **Discovery candidates** (`research_discovery_candidate`): quarantined; promotion ONLY via `research_candidate_promote` gate = exactly-verified × audited-novelty × (records: fresh frontier + improvement PASS) → terminal `human-review`. Nothing auto-publishes.
- **Symmetry reduction first**: circulant spaces (Paley P(17) for R(4,4) rediscovered in 2^8 instead of 2^136); verify the reduction preserves known optima.
- Failed search = `search-exhausted-under-strategy-X` (scoped negative memory), NEVER "doesn't exist".
