# bin/ — ops runbook

All scripts source `bin/env.sh` (`RESEARCH_PORT=8787`, `RESEARCH_HOME=<repo>/workspaces`, `CLI`, `DAEMON_PIDFILE=/tmp/researchd-8787.pid`).

## Bring-up

| Script | What it does |
|---|---|
| `research-tmux.sh [yaml] [workers]` | tmux session `research`: window `daemon` (researchd), `operator` (CLI shell), `worker-N` (interactive Pi in the campaign workspace, bootstrapped via keystrokes). Defaults to `examples/campaigns/euler-prime-interactive.yaml`. |
| `research-headless.sh [yaml] [max_wait]` | starts researchd if needed (nohup, pidfile), creates + starts the campaign, waits for a terminal state, exports the report. Fully autonomous via `workers.autoSpawn`. |
| `research-queue.sh` | ★ starts the **queue supervisor** (`apps/queue`) in tmux window `queue`: runs `examples/open-problems/*.yaml` ONE AT A TIME forever, adopts any hand-started running campaign, exports reports to `workspaces/reports/`, respawns researchd on crash, state in `workspaces/queue.json`. `node apps/queue/dist/main.js --once` = single pass. |
| `research-open-problems.sh [--only N]` | one-shot sequential runner (no watchdog, exits when done) — the supervisor supersedes it for long runs. |
| `research-down.sh` | kills daemon (pidfile + pkill), research workers, tmux session. State survives. |

## Everyday ops

```bash
# status
research doctor                                     # daemon + mesh snapshot
research campaign list; research task c_5; research campaign report c_5

# restart daemon with a new build (state replays automatically)
kill $(cat /tmp/researchd-8787.pid); pnpm -r build
RESEARCH_PORT=8787 RESEARCH_HOME=$PWD/workspaces node apps/researchd/dist/main.js &

# tmux session ops
tmux attach -t research            # windows: daemon / operator / worker-*
tmux capture-pane -p -t research:worker-1 | tail
# ping idle interactive workers when a new campaign starts:
tmux send-keys -t research:worker-1 "New campaign <id> is running — research_claim_task again" C-m
```

## Crash / resume story

Campaign state is event-sourced under `workspaces/c_N-*/state/events.jsonl`. Kill -9 anything; on next daemon start `load()` replays all logs and the scheduler continues. Verified live during bring-up. Workers are disposable — leases expire (requeue, max 3 attempts).

## Gotchas

- Ports/pidfiles are per-port; run only one researchd per `RESEARCH_HOME` unless you set distinct `RESEARCH_PORT`s.
- Interactive tmux workers need a nudge (send-keys) for campaigns created AFTER their session started.
- `research-headless.sh`/`research-open-problems.sh` keep the daemon UP on timeout (exit 2) — check `research campaign status` before relaunching.

## Incident taxonomy + watchdog (v2, 2026-08-23)

Three production incidents shaped the self-healing layer:

| Incident | Symptom | Root cause | Fix |
|---|---|---|---|
| daemon crash + EADDRINUSE | queue watchdog child died binding against a zombie | scheduler ticked before `listen` success | scheduler starts ONLY after bind; bind error ⇒ exit(1) |
| ghost agent_runs (14:05Z) | API healthy, zero events for 2h, no respawns | worker.exited lost on crash ⇒ runningHeadless counted ghosts ⇒ autoSpawn blocked | ghost detection: a headless run is alive only while its task is live (or <25min taskless); ghosts get honest `worker.exited` |
| scheduler silence (invisible to v1 watchdog) | daemon answers /health but nothing happens | the two above, or any future scheduler stall | watchdog v2: EVENT-FILE silence detection |

**Watchdog v2 (apps/queue/src/watchdog.ts)** — liveness = events.jsonl mtime on a running campaign WITH pending work. Escalation ladder per campaign: `warn (10min silence) → SIGTERM daemon (15min) → SIGKILL+respawn (20min) → park campaign for human review (25min)`, with 5-min stage cooldowns and a circuit breaker (max 3 daemon restarts/hour per campaign — beyond that, park instead of flapping). Recovery clears non-terminal incidents; `parked` is sticky (humans own it). State persists in `queue.json.watchdog`. researchd exposes `scheduler.lastTickMs/tickCount/tickErrors` via `/v1/health` (a dead scheduler is distinguishable from an idle queue). Tunables: `RESEARCH_QUEUE_IDLE_MS` (default 600000).

**Ops reflex when suspicious**: `research queue` → any `WATCHDOG ⚠/🟠/🔴/🅿` line maps to the ladder stage; `curl :8787/v1/health | jq .scheduler` tells you if ticks flow; `stat workspaces/c_*/state/events.jsonl` is the durable truth.

## Knowledge consolidation (v0.3)

Done campaigns are CONSOLIDATED into `workspaces/knowledge/` (objects.jsonl + index.json + per-problem reports) — claims verified/falsified with their exact bounds (verifiedDomain preferred, title parsing fallback), dead-ends, active skills. Future campaigns on the same problem receive `ContextPack.priorRuns` (bounds, dead-ends, skills + "EXTEND, DON'T REPEAT"). Claim creation soft-rejects exact duplicates of established knowledge. On campaign completion the supervisor consolidates automatically and applies the T1 re-iteration trigger: if the best bound is below the verifier ceiling, a `<problem>-round2.yaml` is generated and enqueued (sorted AFTER pending novelty runs); at ceiling ⇒ skip (anti-loop). Old campaigns live in `workspaces/archive/` (moved, never deleted — replayable by adding back to registry.json). CLI-adjacent: `lookup(problem)` via core. The queue ledger marks `firstPass: true` on run-1 entries.
