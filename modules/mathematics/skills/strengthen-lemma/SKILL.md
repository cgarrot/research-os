---
name: strengthen-lemma
description: Use when an induction hypothesis or intermediate lemma is too weak to close the argument.
---

# strengthen-lemma

Triggers: induction step almost works; proof needs an invariant the lemma doesn't carry.

1. Identify exactly what information is lost between the lemma and where it's applied.
2. Propose a STRONGER statement that carries that information (extra invariant, tighter bound, additional conclusion).
3. FALSIFY the stronger statement first (test-small-cases) before investing proof effort — stronger statements are easier to prove by induction but easier to kill by counterexample.
4. If it survives, decompose into lemmas and record utility targets (`research_create_hypothesis` with the target in the rationale).
