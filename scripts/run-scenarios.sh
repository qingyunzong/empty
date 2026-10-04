#!/usr/bin/env bash
# Runs the three acceptance scenarios through the real CLI and captures all
# output into result.txt.
set -u
cd "$(dirname "$0")/.."

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

run() {
  echo
  echo "\$ $*"
  "$@"
  echo "(exit=$?)"
  return 0
}

{
echo "# Bitemporal equipment-state audit — CLI acceptance scenarios"
echo "# node: $(node --version)   generated(UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo
echo "======================================================================"
echo "Scenario 1: retroactive correction (past valid_time) changes the"
echo "current view but never the historical AS OF tx_time view"
echo "======================================================================"
LOG1="$WORK/scenario1.log"

cat > "$WORK/s1-tx1.json" <<'JSON'
{"tx_id":"tx-1","tx_time":"2024-01-10T00:00:00Z","events":[
  {"id":"e1","equipment":"pump-1","valid_time":"2024-01-01T08:00:00Z","state":"up"}]}
JSON
cat > "$WORK/s1-tx2.json" <<'JSON'
{"tx_id":"tx-2","tx_time":"2024-01-20T00:00:00Z","events":[
  {"id":"e2","equipment":"pump-1","valid_time":"2024-01-01T12:00:00Z","state":"down"}]}
JSON

run node cli.js append "$LOG1" --file "$WORK/s1-tx1.json"
run node cli.js counts "$LOG1"
run node cli.js state "$LOG1" --equipment pump-1 --valid-time 2024-01-05T00:00:00Z --tx-time 2024-01-15T00:00:00Z
echo
echo "--> retroactive 'down' correction arrives at tx_time 2024-01-20 for valid_time 2024-01-01:"
run node cli.js append "$LOG1" --file "$WORK/s1-tx2.json"
run node cli.js counts "$LOG1"
run node cli.js state "$LOG1" --equipment pump-1 --valid-time 2024-01-05T00:00:00Z
echo
echo "--> historical AS OF tx_time 2024-01-15 is unchanged (still 'up', up=1):"
run node cli.js state "$LOG1" --equipment pump-1 --valid-time 2024-01-05T00:00:00Z --tx-time 2024-01-15T00:00:00Z
run node cli.js counts "$LOG1" --tx-time 2024-01-15T00:00:00Z
run node cli.js verify "$LOG1"

echo
echo "======================================================================"
echo "Scenario 2: out-of-order tx_time — visibility follows transaction"
echo "time, not arrival order"
echo "======================================================================"
LOG2="$WORK/scenario2.log"

cat > "$WORK/s2-txa.json" <<'JSON'
{"tx_id":"tx-a","tx_time":"2024-02-10T10:00:00Z","events":[
  {"id":"e1","equipment":"pump-2","valid_time":"2024-02-01T09:00:00Z","state":"down"}]}
JSON
cat > "$WORK/s2-txb.json" <<'JSON'
{"tx_id":"tx-b","tx_time":"2024-02-05T10:00:00Z","events":[
  {"id":"e2","equipment":"pump-2","valid_time":"2024-02-01T09:00:00Z","state":"up"}]}
JSON

echo "--> tx-a (tx_time 2024-02-10, state=down) arrives FIRST:"
run node cli.js append "$LOG2" --file "$WORK/s2-txa.json"
echo
echo "--> tx-b (tx_time 2024-02-05, EARLIER, state=up) arrives SECOND:"
run node cli.js append "$LOG2" --file "$WORK/s2-txb.json"
echo
echo "--> current view: greatest tx_time (tx-a, 02-10) wins despite arriving first:"
run node cli.js state "$LOG2" --equipment pump-2 --valid-time 2024-02-03T00:00:00Z
echo
echo "--> AS OF tx_time 2024-02-07: only tx-b visible -> 'up'; AS OF 2024-02-04: neither -> null:"
run node cli.js state "$LOG2" --equipment pump-2 --valid-time 2024-02-03T00:00:00Z --tx-time 2024-02-07T00:00:00Z
run node cli.js state "$LOG2" --equipment pump-2 --valid-time 2024-02-03T00:00:00Z --tx-time 2024-02-04T00:00:00Z
run node cli.js counts "$LOG2" --tx-time 2024-02-07T00:00:00Z
run node cli.js verify "$LOG2"

echo
echo "======================================================================"
echo "Scenario 3: atomic batch rejection — invalid schema/time rolls back"
echo "the whole batch; counts and hash are unchanged"
echo "======================================================================"
LOG3="$WORK/scenario3.log"

cat > "$WORK/s3-tx1.json" <<'JSON'
{"tx_id":"tx-1","tx_time":"2024-03-10T00:00:00Z","events":[
  {"id":"e1","equipment":"valve-1","valid_time":"2024-03-01T08:00:00Z","state":"up"},
  {"id":"e2","equipment":"valve-2","valid_time":"2024-03-01T08:30:00Z","state":"down"}]}
JSON
cat > "$WORK/s3-bad.json" <<'JSON'
{"tx_id":"tx-2","tx_time":"2024-03-11T00:00:00Z","events":[
  {"id":"e3","equipment":"valve-1","valid_time":"2024-03-02T08:00:00Z","state":"down"},
  {"id":"e4","equipment":"valve-2","valid_time":"not-a-timestamp","state":"up"},
  {"id":"e5","equipment":"valve-3","valid_time":"2024-03-02T09:00:00Z","state":"sideways"}]}
JSON

run node cli.js append "$LOG3" --file "$WORK/s3-tx1.json"
run node cli.js hash "$LOG3"
run node cli.js counts "$LOG3"
echo
echo "--> batch with one illegal valid_time and one illegal state is rejected as a whole:"
run node cli.js append "$LOG3" --file "$WORK/s3-bad.json"
echo
echo "--> hash, counts and log size are identical after the rejected batch:"
run node cli.js hash "$LOG3"
run node cli.js counts "$LOG3"
run wc -l "$LOG3"
run node cli.js verify "$LOG3"
} > result.txt 2>&1

echo "wrote result.txt"
