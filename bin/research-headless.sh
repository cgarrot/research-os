#!/usr/bin/env bash
# research-headless.sh — fully autonomous run (no tmux workers):
#   starts researchd, creates + starts the campaign, lets the scheduler spawn
#   headless Pi workers (spec workers.autoSpawn), waits for a terminal state,
#   prints the report location. Crash-safe: state is event-sourced.
#
# usage: research-headless.sh [campaign.yaml] [max_wait_seconds]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

CAMPAIGN_YAML="${1:-$ROOT/examples/campaigns/euler-prime.yaml}"
MAX_WAIT="${2:-1800}"

[ -f "$ROOT/apps/researchd/dist/main.js" ] || (cd "$ROOT" && pnpm -r build)

if ! $CLI doctor >/dev/null 2>&1; then
  echo "[headless] starting researchd on :$RESEARCH_PORT (home=$RESEARCH_HOME)"
  RESEARCH_PORT=$RESEARCH_PORT RESEARCH_HOME=$RESEARCH_HOME nohup node "$ROOT/apps/researchd/dist/main.js" \
    > "$RESEARCH_HOME/researchd.log" 2>&1 &
  echo $! > "$DAEMON_PIDFILE"
  mkdir -p "$RESEARCH_HOME"
  for i in $(seq 1 20); do $CLI doctor >/dev/null 2>&1 && break; sleep 0.5; done
fi
$CLI doctor >/dev/null || { echo "researchd unreachable"; exit 1; }

CID=$($CLI campaign create "$CAMPAIGN_YAML" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
$CLI campaign start "$CID" >/dev/null
echo "[headless] campaign $CID running (workers auto-spawn, watching…)"

DEADLINE=$(( $(date +%s) + MAX_WAIT ))
while :; do
  STATUS=$($CLI campaign status "$CID" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
  if [ "$STATUS" != "running" ] && [ "$STATUS" != "paused" ]; then
    echo "[headless] campaign $STATUS"
    break
  fi
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "[headless] timeout after ${MAX_WAIT}s — campaign still running (daemon stays up)"
    exit 2
  fi
  sleep 5
done

$CLI campaign report "$CID" > "$RESEARCH_HOME/report-$CID.md" 2>/dev/null || true
echo "[headless] report: $RESEARCH_HOME/report-$CID.md"
$CLI task "$CID" || true
