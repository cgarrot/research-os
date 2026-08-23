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
