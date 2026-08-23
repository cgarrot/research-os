---
name: exact-arithmetic-first
description: Use when running any mathematical computation as evidence. Exact integers/Fractions only — floating point is exploration, never evidence.
---

# exact-arithmetic-first

- Evidence = exact integer / rational arithmetic (`int`, `fractions.Fraction`, `sympy` exact forms).
- Floats are allowed only to *explore*; any number that ends in a claim, artifact or verifier request must come from an exact computation.
- Register the computing code AND its output as artifacts (`research_create_artifact`), then attach as evidence.
- The verifiers recompute everything from scratch — your script is the claim, their run is the truth.
