---
name: falsify-before-proving
description: Use before spending any expensive effort (long experiments, proof attempts) on a new hypothesis.
---

# falsify-before-proving

1. Derive the smallest set of falsifiable consequences of the hypothesis.
2. Order them by cost: hand-checkable < seconds < minutes.
3. Attack the cheapest ones adversarially first (edge cases, minimal witnesses, modular obstructions).
4. Only spend expensive resources (large scans, proof search) after cheap falsification fails.
5. Interpret correctly: failure to find a counterexample is NOT evidence of truth — it is permission to invest.

A hypothesis killed in 5 seconds saves an hour. Record the kill as negative memory (`research_submit_task_result` with blockers/summary) so nobody retries it blind.
