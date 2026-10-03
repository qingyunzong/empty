#!/usr/bin/env bash
# Regenerates result.txt with the real test-suite output and real CLI
# exit codes/outputs for the three acceptance scenarios.
set -u
cd "$(dirname "$0")/.."
OUT=result.txt
STATE_DIR="$(mktemp -d)"
trap 'rm -rf "$STATE_DIR"' EXIT

: > "$OUT"
run() {
  {
    echo "\$ $*"
    "$@" 2>&1
    code=$?
    echo "[exit code: $code]"
    echo
  } >> "$OUT"
}

{
  echo "# Acceptance run $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# node $(node --version)"
  echo
} >> "$OUT"

run node --test

echo "## Scenario 1: tight capacity, multiple optima, lexicographic tie-break" >> "$OUT"
run node cli.js schedule examples/scenario1-tie.json --state "$STATE_DIR/s1.json"

echo "## Scenario 2: due conflict proven infeasible with minimal subset certificate" >> "$OUT"
run node cli.js schedule examples/scenario2-infeasible.json --state "$STATE_DIR/s2.json"

echo "## Scenario 3: undo of a capacity cut restores the original optimum" >> "$OUT"
run node cli.js schedule examples/scenario3-base.json --state "$STATE_DIR/s3.json"
run node cli.js apply examples/scenario3-cut-capacity.json --state "$STATE_DIR/s3.json"
run node cli.js undo --state "$STATE_DIR/s3.json"
run node cli.js redo --state "$STATE_DIR/s3.json"

echo "wrote $OUT"
