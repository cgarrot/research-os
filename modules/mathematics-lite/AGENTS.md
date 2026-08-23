# modules/mathematics-lite — minimal reference module

The smallest working module: 2 verifiers (`counterexample-check`, `holds-check`), a handful of roles/descriptors, no skills. Exists as the canonical "hello module" and powers the Euler `n²+n+41` rediscovery demo (`examples/campaigns/euler-prime*.yaml`).

- `verifiers/check.py` is a SIMPLER sibling of the full module's script (expression over `n` only: `n*n+n+41`-style claims, predicates `prime not_prime even odd equals:K divisible_by:K greater_than:K less_than:K`).
- `counterexample-check`: witness + failing predicate → `falsified`. `holds-check`: single n, predicate holds → `empirically_supported` (one point is never a proof — note the deliberate asymmetry with the full module's exhaustive verifier).

Use it as a template when writing a new module; use `modules/mathematics` when you need the full exact library.
