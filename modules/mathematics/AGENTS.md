# modules/mathematics — the mathematics domain module

Epistemic grades map onto core statuses: `verified` = M4 (exact finite) or M5-lite (symbolic identity), `falsified` = FALSIFIED_EXACT, `empirically_supported` = M2, `source_supported` = M3. Lean (M5/M6) arrives as an extra verifier when a toolchain is installed — it is deliberately optional.

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

## Proven workflow

The canonical live pattern: state the bounded claim with an explicit `bound`,
verify with `exhaustive-finite` on the natural variable (use `goldbach_even` /
`legendre_gap` instead of variable mappings), and attach witnesses through
`certificate-check`. The engine test suite covers every transition.
