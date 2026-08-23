# examples/ — campaign YAML norm

Every campaign file has ONE top-level key `campaign:` consumed by `research campaign create <file>` (shapes: `CampaignSpec` in `packages/contracts/src/campaign.ts`; defaults filled by `normalizeSpec` in researchd).

```
examples/
  campaigns/            curated demos (euler rediscovery: headless + interactive variants)
  open-problems/        numbered unsolved-problem queue — see its AGENTS.md
```

## Fields that matter

- `title` — ends up in every report header
- `modules: [mathematics]` — enables the module's verifiers/skills/prompts (isolation is enforced)
- `objective.statement` — immutable for workers; write it as an OPERATIONAL goal ("verified bounded progress", "falsify auxiliaries"), never "prove X" on open problems
- `objective.successCriteria[]` — `{type: claim_status, value: verified|falsified}` / `{type: verified_object, value: <object type>}` / `{type: artifact}`. claim_status only counts when a VERIFIER produced the transition (invariant C)
- `objective.questions[]` — become the grounding map's targets
- `search.blindGenerators` / `maxBranches` — diversity budget for the generate phase
- `budgets` — agent runs / tasks / rounds / experiments / wall-clock minutes / token estimate
- `workers.autoSpawn` — 2 = researchd spawns headless Pi workers itself; 0 = interactive-only (pair with `bin/research-tmux.sh`)
- `stop` — onSuccess / onBudgetExhausted / noProgressRounds

## Conventions

- Success = criteria met (usually: one `verified` + one `falsified`). Frame open problems so that verified bounded progress satisfies them.
- Interactive variant of a campaign = same file with `autoSpawn: 0` (see `euler-prime-interactive.yaml`).
- After a run: `research campaign report <id> > workspaces/report-campaign:<id>.md` keeps evidence next to state.
