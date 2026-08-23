---
name: canonicalize-objects
description: Use when enumerating objects — store canonical representatives, not arbitrary instances, or your census lies.
---

# canonicalize-objects

1. Define the equivalence explicitly (isomorphism, permutation, complement).
2. Pick a canonical form: min over the group orbit (lexicographic), or a normal form (sorted invariant vector).
3. Hash the canonical form — dedupe censuses by hash, never by raw encoding.
4. Two independent implementations of the enumerator must agree on the small census before scaling (definition gate).
