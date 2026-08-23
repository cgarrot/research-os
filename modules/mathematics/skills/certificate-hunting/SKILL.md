---
name: certificate-hunting
description: Use when searching for a checkable combinatorial witness (coloring, graph, packing...). Long searches are durable jobs, never agent turns.
---

# certificate-hunting

1. From the frontier predicate: define candidate object + validity + metric. Write the certificate spec.
2. Reproduce the KNOWN best certificate first (validator sanity: known-positive must PASS; known-negative must FAIL).
3. Symmetry-reduce the search space BEFORE brute force (cyclic/circulant forms, color permutation, complementation) — verify the reduction doesn't remove ALL optimal candidates.
4. Long search ⇒ `research_job_create` running hunt.py: `python3 <module>/python/hunt.py --problem vdw|ramsey|ramsey-circulant --strategy sa|random-restart|hill|tabu|evo --seconds N --seed S --checkpoint ckpt.json`. Custom problems: write your own runner in experiments/ (checkpoint + NDJSON PROGRESS + final independent validate).
5. Portfolio beats single strategy: rugged landscapes trap SA (seen: -17 basin vs Paley optimum) — run several strategies/seeds as parallel jobs; keep the best.
6. A found candidate is NOTHING until the independent verifier passes: submit via certificate-check with verify() + exact cross-check. Then `research_discovery_candidate` (quarantined).
7. Failed search = `search-exhausted-under-strategy-X` (negative memory with scope), NEVER "no certificate exists".
