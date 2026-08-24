#!/usr/bin/env bash
# research-down.sh — stop researchd and any headless Pi workers it spawned.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

# kill daemon(s) started by our scripts
if [ -f "$DAEMON_PIDFILE" ]; then
  PID=$(cat "$DAEMON_PIDFILE")
  kill "$PID" 2>/dev/null && echo "researchd (pid $PID) stopped" || echo "researchd pid $PID already gone"
  rm -f "$DAEMON_PIDFILE"
fi
pkill -f "apps/researchd/dist/main.js" 2>/dev/null && echo "stray researchd processes killed" || true

# headless research workers (spawned by researchd carry RESEARCH_WORKER_ALIAS)
pkill -f "RESEARCH_WORKER_ALIAS.*pi|pi.*research-worker" 2>/dev/null || true

# tmux session if present
tmux has-session -t "${RESEARCH_SESSION:-research}" 2>/dev/null && {
  tmux kill-session -t "${RESEARCH_SESSION:-research}" && echo "tmux session stopped"
} || true

echo "down. campaign state is durable under $RESEARCH_HOME — restart any time (researchd replays events)."

# Kill orphan Python experiments from archived/stopped campaigns
echo "cleaning orphan Python experiments..."
for pid in $(pgrep -f "Python.*experiments/" 2>/dev/null); do
  cwd=$(lsof -p $pid 2>/dev/null | grep cwd | awk '{print $NF}')
  if [ -n "$cwd" ]; then
    ws_id=$(echo "$cwd" | grep -o 'c_[0-9]*' | head -1)
    # check if the campaign is still running
    status=$(curl -s http://127.0.0.1:8787/v1/campaigns 2>/dev/null | python3 -c "
import json, sys
try:
    for c in json.load(sys.stdin):
        if ws_id and ws_id in c.get('workspace',''):
            print(c['status'])
            break
    else:
        print('not-found')
except:
    print('unknown')
" 2>/dev/null)
    if [ "$status" = "stopped" ] || [ "$status" = "completed" ] || [ "$status" = "not-found" ]; then
      kill $pid 2>/dev/null
      echo "  killed zombie pid=$pid ($ws_id, status=$status)"
    fi
  fi
done
