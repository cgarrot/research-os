---
name: mine-exact-sequences
description: Use to turn exact censuses into sequence candidates with full provenance and novelty auditing.
---

# mine-exact-sequences

1. Terms must be EXACT integers (floats are exploration only). Every term: parameter, algorithm version, supporting artifact.
2. Store as a sequence_candidate object: offset, terms, generation method, artifacts.
3. OEIS audit BOTH by values (several prefixes + offset windows) AND by definition keywords.
4. Known-sequence extension: check b-files/references, not just the main display; reproduce the last published term first.
5. On top: pattern mining — monotonicity, modular behavior, recurrences, record transitions → rival hypotheses → discriminating experiments.
