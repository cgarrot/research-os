---
name: symmetry-reduction
description: Use before any combinatorial brute force — quotient the search space by its symmetries, then verify the quotient still contains optima.
---

# symmetry-reduction

1. List the symmetry group acting on candidates: vertex relabeling (graph iso), color permutation, cyclic shifts/reflections (translation-invariant constraints), complementation, parameter swap.
2. Restrict to canonical representatives (circulant/connection-set forms, lexicographic min under the group, zippered cyclic forms for van der Waerden).
3. MEASURE the win: space size before/after; example — 17-vertex Ramsey graphs: 2^136 edge sets → 2^8 circulants (Paley P(17) lives there).
4. Verify the restriction: known optima must survive it (reproduce the known record inside the reduced space). If not, hybrid: reduced space first, full space as fallback.
5. Record the equivalence + hash candidates after canonicalization to kill duplicates in archives.
