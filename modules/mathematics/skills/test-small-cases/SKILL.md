---
name: test-small-cases
description: Use when meeting any new universal or existential mathematical claim, before any proof investment.
---

# test-small-cases

Triggers: universally quantified discrete statement, new conjecture, new lemma.

1. Enumerate the smallest valid inputs by hand/script (include boundary cases: n=1, n=2, powers of 2, small primes, 0 if allowed).
2. Record exact outputs; look for the minimal failure.
3. If it dies small → `research_request_verification` with `mathematics:exact-counterexample` (FALSIFIED, cheap, definitive).
4. If it survives small → scale up with exact code, then request `mathematics:exhaustive-finite` on the largest complete domain your budget allows (VERIFIED bounded claim).

Warning: success on 10^6 cases is *support*, not proof. State the bound you actually verified.
