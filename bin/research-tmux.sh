#!/usr/bin/env bash
# research-tmux.sh — bring ResearchOS up inside tmux:
#   window 1  daemon    : researchd (HTTP API + scheduler)
#   window 2  operator  : shell with the `research` CLI
#   window 3+ worker-N  : interactive Pi workers (ZAI GLM-5.3), same pi-mesh broker
#
# usage: research-tmux.sh [campaign.yaml] [worker_count]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

CAMPAIGN_YAML="${1:-$ROOT/examples/campaigns/euler-prime-interactive.yaml}"
WORKERS="${2:-2}"
SESSION="${RESEARCH_SESSION:-research}"

command -v tmux >/dev/null || { echo "tmux required"; exit 1; }
[ -f "$ROOT/apps/researchd/dist/main.js" ] || (cd "$ROOT" && pnpm -r build)

tmux has-session -t "$SESSION" 2>/dev/null && { echo "tmux session '$SESSION' already exists (bin/research-down.sh to stop)"; exit 1; }

# 1. daemon
tmux new-session -d -s "$SESSION" -n daemon -c "$ROOT"
tmux send-keys -t "$SESSION:daemon" "RESEARCH_PORT=$RESEARCH_PORT RESEARCH_HOME=$RESEARCH_HOME node apps/researchd/dist/main.js" C-m
sleep 2
$CLI doctor >/dev/null || { echo "researchd did not come up"; tmux kill-session -t "$SESSION"; exit 1; }

# 2. campaign create + start
CID_JSON=$($CLI campaign create "$CAMPAIGN_YAML")
CID=$(echo "$CID_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
WS=$($CLI campaign status "$CID" | python3 -c 'import json,sys; print(json.load(sys.stdin)["workspace"])')
$CLI campaign start "$CID" >/dev/null
SHORT="${CID#campaign:}"
echo "campaign $CID workspace $WS"

# 3. operator window
tmux new-window -t "$SESSION" -n operator -c "$ROOT"
tmux send-keys -t "$SESSION:operator" "export RESEARCH_URL=$RESEARCH_URL; alias research='$CLI'; research campaign status $SHORT; echo 'try: research task $SHORT | research campaign events $SHORT | research campaign report $SHORT'" C-m

# 4. worker windows (interactive Pi, campaign workspace = project-local extension + skill)
for i in $(seq 1 "$WORKERS"); do
  tmux new-window -t "$SESSION" -n "worker-$i" -c "$WS"
  tmux send-keys -t "$SESSION:worker-$i" "RESEARCH_URL=$RESEARCH_URL RESEARCH_WORKER_ALIAS=tmux-w$i RESEARCH_CAMPAIGN=$CID pi --name research-$SHORT-w$i" C-m
  sleep 3
  tmux send-keys -t "$SESSION:worker-$i" "Bootstrap: you are ResearchOS worker tmux-w$i for campaign $CID. Follow the research-worker skill: research_claim_task, execute, research_submit_task_result, loop until no tasks." C-m
done

tmux select-window -t "$SESSION:operator"
echo ""
echo "ResearchOS is up in tmux session '$SESSION':"
echo "  tmux attach -t $SESSION      # windows: daemon / operator / worker-*"
echo "  campaign: $CID  (room: campaign.${SHORT/_/-})"
echo "  stop:     bin/research-down.sh"
