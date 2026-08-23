---
name: novelty-audit
description: Use when a candidate might be new. Your job is to DISPROVE novelty — search aggressively for prior art, not to validate excitement.
---

# novelty-audit (adversarial)

1. Normalize the claim: statement, aliases/notation variants, structural descriptors.
2. Search PLAN, not one query — `research_novelty_search` with variants: exact phrase, notation, definition keywords, initial values (sequences), structural analogue.
3. Sequences: OEIS value search on SEVERAL prefixes (full, first half, offset-shifted window) + definition search. No-hit on one prefix is NOT novelty.
4. Literature: OpenAlex + arXiv + Crossref (recent window included). Inspect close matches yourself — don't trust hit counts.
5. Statuses are conservative: `known` (match found) / `ambiguous` (probable match unresolved) / `not-found` (coverage gaps remain) / `likely-new-after-audited-search` (only after the full plan, ≥3-4 providers incl OEIS for sequences, exact+definition+structural+recent queries, no probable match). Quick mode NEVER yields likely-new.
6. Provider outage ⇒ coverage inconclusive (never novelty). Update the audit object with evidence ids + missing coverage; final "new" always requires human review.
