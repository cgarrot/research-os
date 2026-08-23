---
name: minimal-counterexample
description: Use when a universal discrete claim resists direct attack — reason about the smallest potential counterexample instead.
---

# minimal-counterexample

1. Assume a counterexample exists; pick one minimizing a natural measure (value, size, norm, trajectory length).
2. Derive structural consequences of minimality (parity, divisibility, no smaller witness of the same shape).
3. Try to reduce it to a smaller counterexample → contradiction, or exhibit the actual minimal witness exactly.

If you find the witness: `exact-counterexample` verification. If you derive the contradiction informally: record each reduction as a separate lemma object so each piece can later be attacked/verified independently.
