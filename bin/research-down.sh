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
