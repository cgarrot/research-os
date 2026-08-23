# pi/research-os-pi — the Pi worker extension (`research_*` tools)

Turns any Pi session in a campaign workspace into a ResearchOS worker. Campaign scaffolding (`packages/core/src/campaignService.ts`) copies `extension/` → `<workspace>/.pi/extensions/research-os/` and `skills/` → `<workspace>/.pi/skills/` at campaign creation, so **edits here only reach NEW campaigns** (existing workspaces keep their copy).

## Extension (`extension/index.ts`)

- Registers ~20 `research_*` tools (read / write / coordination, spec §8) + a `/research` command + a status line.
- All tools POST to researchd (`RESEARCH_URL`). Errors surface as `ERROR: researchd <code>: <msg>` — workers are told to react, not crash.
- Env contract: `RESEARCH_WORKER_ALIAS` (lease identity), `RESEARCH_CAMPAIGN` (scoping), `PI_SESSION_FILE` present ⇒ interactive mode.
- **Task mutations MUST send `campaignId`** (cross-campaign id collisions — see root gotchas). `research_submit_task_result` and `research_release_task` already do.
- `research_claim_task` renders the ContextPack head + module guidance; `research_get_context` re-fetches it.

## Worker skill (`skills/research-worker/SKILL.md`)

The loop: claim → read ContextPack → execute (persist as you go) → `research_submit_task_result` → repeat. Hard rules: never self-promote to verified/falsified, never fabricate, persist before announcing, failures are valuable.

## Testing changes here

```bash
# from a NEUTRAL directory (never a repo with its own .pi/)
cd ~/pi-scratch && pi -p --no-session -e /abs/path/to/research-os-pi/extension/index.ts "say OK"
```
Then smoke the full loop with a real campaign (`bin/research-headless.sh`) and watch the worker session file under `~/.pi/agent/sessions/--…workspaces-c_N-…--`.

## Adding a tool

1. `pi.registerTool(tool(name, description, {params}, run))` — keep output brief (`brief()`), details in `details`.
2. If it mutates research state: add the researchd route first (see `apps/researchd/AGENTS.md`), then the tool calls it with `campaignId`.
3. Update `toolGuide()` in `packages/core/src/contextBuilder.ts` so workers discover it.
