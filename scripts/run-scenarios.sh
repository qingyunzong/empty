#!/usr/bin/env bash
# Runs the three acceptance scenarios against the real CLI and captures the
# genuine output into result.txt.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="$ROOT/result.txt"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

run() {
  echo
  echo "\$ $*"
  "$@" 2>&1
  echo "(exit=$?)"
}

{
  echo "Bitemporal equipment-state audit - CLI acceptance scenarios"
  echo "generated: $(date -u +%Y-%m-%dT%H:%M:%SZ) | node $(node --version) | append-only log, corrections never overwrite"

  echo
  echo "================================================================"
  echo "Scenario 1: retroactive correction of a past valid_time"
  echo "  tx-001 records pump-7=up @2024-03-10; tx-002 later says it was"
  echo "  actually down. The current view must flip to down, while an AS OF"
  echo "  query at the old tx_time must still answer up."
  echo "================================================================"
  D1="$WORK/s1"
  run node cli.js --data "$D1" append examples/sc1-tx1.json
  run node cli.js --data "$D1" asof pump-7 2024-03-10T00:00:00Z 2024-03-10T02:00:00Z
  run node cli.js --data "$D1" append examples/sc1-tx2.json
  run node cli.js --data "$D1" asof pump-7 2024-03-10T00:00:00Z
  run node cli.js --data "$D1" asof pump-7 2024-03-10T00:00:00Z 2024-03-10T02:00:00Z
  run node cli.js --data "$D1" counts
  run node cli.js --data "$D1" verify

  echo
  echo "================================================================"
  echo "Scenario 2: out-of-order tx_time"
  echo "  tx-101 (tx_time 2024-05-10, up) commits first; tx-102 (tx_time"
  echo "  2024-05-05, down) arrives second but carries the EARLIER tx_time."
  echo "  Visibility follows transaction time, not arrival order: current"
  echo "  view stays up; a view between the two tx_times sees down."
  echo "================================================================"
  D2="$WORK/s2"
  run node cli.js --data "$D2" append examples/sc2-txA.json
  run node cli.js --data "$D2" append examples/sc2-txB.json
  run node cli.js --data "$D2" asof valve-3 2024-05-01T00:00:00Z
  run node cli.js --data "$D2" asof valve-3 2024-05-01T00:00:00Z 2024-05-07T00:00:00Z
  run node cli.js --data "$D2" asof valve-3 2024-05-01T00:00:00Z 2024-05-04T00:00:00Z
  run node cli.js --data "$D2" counts
  run node cli.js --data "$D2" verify

  echo
  echo "================================================================"
  echo "Scenario 3: invalid batch rolls back atomically"
  echo "  tx-202 contains one valid event plus a bad state and an impossible"
  echo "  date (2024-02-30). The whole batch must be rejected: counts and"
  echo "  hash identical before and after."
  echo "================================================================"
  D3="$WORK/s3"
  run node cli.js --data "$D3" append examples/sc3-tx1.json
  run node cli.js --data "$D3" counts
  run node cli.js --data "$D3" hash
  run node cli.js --data "$D3" append examples/sc3-bad.json
  run node cli.js --data "$D3" counts
  run node cli.js --data "$D3" hash
  run node cli.js --data "$D3" verify
} > "$OUT" 2>&1

echo "wrote $OUT"
