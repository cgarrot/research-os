#!/usr/bin/env bash
# Common env for ResearchOS scripts.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export RESEARCH_PORT="${RESEARCH_PORT:-8787}"
export RESEARCH_URL="http://127.0.0.1:${RESEARCH_PORT}"
export RESEARCH_HOME="${RESEARCH_HOME:-$ROOT/workspaces}"
CLI="node $ROOT/apps/cli/dist/main.js"
DAEMON_PIDFILE="/tmp/researchd-${RESEARCH_PORT}.pid"
