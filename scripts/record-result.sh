#!/usr/bin/env bash
# Records real stdout and exit codes of the acceptance runs into result.txt.
set -u
cd "$(dirname "$0")/.."
OUT=result.txt
: > "$OUT"

record() {
  echo "================================================================" >> "$OUT"
  echo "\$ $*" >> "$OUT"
  echo "----------------------------------------------------------------" >> "$OUT"
  "$@" >> "$OUT" 2>&1
  local code=$?
  echo "[exit code: $code]" >> "$OUT"
  echo >> "$OUT"
}

record node src/cli.js schedule examples/feasible.json --budget 1000
record node src/cli.js schedule examples/infeasible.json --budget 1000
record node src/cli.js schedule examples/feasible.json --budget 0
record node src/cli.js schedule examples/feasible.json --budget 100000
record node src/cli.js schedule examples/bad-noninteger.json
record node src/cli.js schedule examples/bad-machine.json
record node src/cli.js schedule examples/missing.json
record node --test
