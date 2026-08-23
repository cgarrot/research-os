---
name: bounded-verification
description: Use to convert an open universal conjecture into exactly-verified finite progress (the standard move on open problems).
---

# bounded-verification

An open "∀ n" conjecture cannot be settled by computation — but its bounded version CAN be proven:

1. State the bounded claim precisely: "P(n) holds for every integer n with 1 ≤ n ≤ K".
2. Create it as a claim object (`research_create_claim`) with the bound in the statement.
3. Request `research_request_verification` with verifier `mathematics:exhaustive-finite`,
   input `{ expression: "n", variables: [{"name":"n","min":1,"max":K}], predicate: "…" }`.
4. Complete domain check ⇒ the bounded claim becomes **verified**. Honest, citable, reproducible progress.
5. Push K as high as the case cap (5M) and time budget allow; report the exact K reached.

Rules: never let the claim statement say "for all n" when you verified "for all n ≤ K". Partial ranges (sampled, or K below the claim's domain) ⇒ use `mathematics:numerical-evidence` instead (support only).
