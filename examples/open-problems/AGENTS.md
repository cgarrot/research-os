# examples/open-problems/ — unsolved-problems queue (ONE AT A TIME)

Numbered campaigns from the FR Wikipedia *Problèmes non résolus en mathématiques*. The number prefix IS the execution order. **01-06 are hand-written; 07-54 are GENERATED from `catalog.json`** (all remaining problems from the page, triaged):

```bash
node bin/generate-open-problem-campaigns.mjs           # regenerate 07+ (idempotent, never touches 01-06)
node bin/generate-open-problem-campaigns.mjs --check   # drift check (exit 1 if yamls differ from catalog)
```

## Modes & profiles (catalog fields)

- `mode`: `frontier-record` (dated frontier snapshot FIRST, then certificate hunt via durable jobs, promotion gate) · `new-object` (define object → exact census → novelty audit → conjectures) · `bounded` (exactly-verified bound reachable with today's verifier library) · `aux` (falsification/witness-centric) · `search` (witness hunt — runs the FULL budget, `stop.onSuccess: false`) · `exploration` (grounding/formulations, quick profile).
- `profile`: `standard` (4h ceiling) · `deep` (10h) · `quick` (1h). Ceilings, not durations — most campaigns end earlier on criteria.

Success criteria are **OR semantics**: the first satisfied criterion completes the campaign; reports show honestly which ones were met. `search`-mode campaigns only stop on budget/rounds/no-progress.

## Execution

- **Long-run**: `bin/research-queue.sh` — the supervisor (`apps/queue`, tmux window `queue`) chains problems forever, adopts hand-started campaigns, exports reports to `workspaces/reports/`, respawns researchd on crash. Progress: `workspaces/queue.json` (done/failed/current).
- One-shot: `bin/research-open-problems.sh [--only N]` (no watchdog; exits when done).

Never start problem N+1 manually while N is running (the supervisor enforces it).

## Verifier armory (modules/mathematics/verifiers/check.py)

`collatz_*` · `is_prime` (deterministic Miller-Rabin < 3.3e24) · `next_prime_gap` · `prime_pi` · `goldbach_count` · `primorial` · `divisor_sum` · `factorial` · `gilbreath_rows_ok` · `is_mersenne_prime` (Lucas-Lehmer) · `square/not_square` — directly covers 01-24; 25+ rely on worker scripts + pointwise verification of witnesses/certificates (exact-point works for any arithmetic statement).

## Adding problem N+1

Edit `catalog.json` (next number, mode, profile, focus text), regenerate, validate the YAML parses. If the exact function needed doesn't exist yet: add it to `check.py` + engine test FIRST, then the catalog entry.

## Ledger

- `workspaces/queue.json` — done[] / failed[] / current. Re-pick a failed problem by removing its failed[] entry (or renaming the YAML higher).
- Reports land in `workspaces/reports/<slug>.md`.
- `stopped` (budget end) is terminal like `completed` — the queue always advances; exploration-only problems produce honest reports and chain.

## Done so far

| Problem | Campaign | Result |
|---|---|---|
| 01-collatz-syracuse | c_5 | completed — verified [1, 5·10⁶] (exhaustive 5M/5M) + falsified auxiliary + empirical |
| 02-goldbach | c_6 | completed — 2 verified bounded claims (reduced-residue depth checks on [10, 10⁵]) |
| (duplicate bootstrap artifact) | c_7 | stopped — ignore |
| 03-legendre | c_8 | started by the supervisor 2026-08-22T23:15Z |
| 04-brocard … 54-birch-swinnerton-dyer | — | queued (numeric order) |
