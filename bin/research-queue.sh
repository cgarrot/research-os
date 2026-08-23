#!/usr/bin/env bash
# research-queue.sh — start the queue supervisor (one campaign at a time, forever)
# in the tmux session `research` (window "queue"). The supervisor:
#   - ADOPTS any currently running campaign (waits for it, exports its report)
#   - then chains through examples/open-problems/*.yaml in order
#   - respawns researchd if it crashes (campaign state replays from events)
#   - records progress in workspaces/queue.json, reports in workspaces/reports/
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
SESSION="${RESEARCH_SESSION:-research}"

[ -f "$ROOT/apps/queue/dist/main.js" ] || (cd "$ROOT" && pnpm -r build)

if tmux has-session -t "$SESSION" 2>/dev/null; then
  if ! tmux list-windows -t "$SESSION" -F "#{window_name}" | grep -qx queue; then
    tmux new-window -d -t "$SESSION" -n queue -c "$ROOT"
  fi
else
  tmux new-session -d -s "$SESSION" -n queue -c "$ROOT"
fi
tmux send-keys -t "$SESSION:queue" "RESEARCH_PORT=$RESEARCH_PORT RESEARCH_HOME=$RESEARCH_HOME node apps/queue/dist/main.js" C-m
echo "queue supervisor started in tmux:  tmux attach -t $SESSION  → window 'queue'"
echo "watch:  tail -f $RESEARCH_HOME/queue.json   |   reports land in $RESEARCH_HOME/reports/"
