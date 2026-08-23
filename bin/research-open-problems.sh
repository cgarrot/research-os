#!/usr/bin/env bash
# research-open-problems.sh — run open-problem campaigns ONE AT A TIME.
# Each campaign runs to a terminal state (completed/stopped/paused) before the
# next one starts. Reports are exported after each.
#
# usage: research-open-problems.sh [--only <number|file>] [dir]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

DIR="${examples_dir:-}"
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    *) DIR="${DIR:-$1}"; shift ;;
  esac
done
DIR="${DIR:-$ROOT/examples/open-problems}"
REPORT_DIR="$RESEARCH_HOME/reports"
mkdir -p "$REPORT_DIR"

[ -x "$ROOT/apps/cli/dist/main.js" ] || (cd "$ROOT" && pnpm -r build)

# bring researchd up if needed (same convention as research-headless.sh)
if ! $CLI doctor >/dev/null 2>&1; then
  echo "[open-problems] starting researchd on :$RESEARCH_PORT (home=$RESEARCH_HOME)"
  RESEARCH_PORT=$RESEARCH_PORT RESEARCH_HOME=$RESEARCH_HOME nohup node "$ROOT/apps/researchd/dist/main.js" \
    > "$RESEARCH_HOME/researchd.log" 2>&1 &
  echo $! > "$DAEMON_PIDFILE"
  for _ in $(seq 1 20); do $CLI doctor >/dev/null 2>&1 && break; sleep 0.5; done
fi
$CLI doctor >/dev/null || { echo "researchd unreachable"; exit 1; }

FILES=()
while IFS= read -r f; do FILES+=("$f"); done < <(ls "$DIR"/*.yaml | sort)
if [ -n "$ONLY" ]; then
  MATCHED=()
  for f in "${FILES[@]}"; do
    case "$(basename "$f" .yaml)" in
      "$ONLY"|"$ONLY"-*) MATCHED+=("$f") ;;
      0"$ONLY"-*) MATCHED+=("$f") ;;
    esac
  done
  [ ${#MATCHED[@]} -gt 0 ] || { echo "no campaign matches --only $ONLY"; exit 1; }
  FILES=("${MATCHED[@]}")
fi

for f in "${FILES[@]}"; do
  NAME=$(basename "$f" .yaml)
  echo ""
  echo "==================================================================="
  echo "[open-problems] starting: $NAME  (one at a time)"
  echo "==================================================================="
  CID=$($CLI campaign create "$f" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
  $CLI campaign start "$CID" >/dev/null
  echo "[open-problems] campaign $CID running (autoSpawn workers claim tasks; waiting for terminal state…)"
  while :; do
    STATUS=$($CLI campaign status "$CID" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
    [ "$STATUS" != "running" ] && [ "$STATUS" != "paused" ] && break
    sleep 10
  done
  $CLI campaign report "$CID" > "$REPORT_DIR/$NAME.md" 2>/dev/null || true
  echo "[open-problems] $NAME -> $STATUS  report: $REPORT_DIR/$NAME.md"
done

echo ""
echo "[open-problems] queue complete. reports in $REPORT_DIR/"
