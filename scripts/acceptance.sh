#!/usr/bin/env bash
# Acceptance demo: kill the exec process at both fault points, recover, and
# verify the total dose matches the no-fault reference.
set -u
cd "$(dirname "$0")/.."
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "== reference run (no fault) =="
node cli.js exec --plan plan.json --journal "$WORK/ref/j" --out "$WORK/ref/out" > /dev/null
REF_TOTAL=$(node -e "
const fs=require('fs');
const t=fs.readFileSync('$WORK/ref/out/dose_ledger.jsonl','utf8').trim().split('\n')
  .map(JSON.parse).reduce((a,e)=>a+e.dose,0);
console.log(t);")
echo "reference total dose: $REF_TOTAL"

for POINT in intent effect; do
  echo "== crash after $POINT (seq 2), then recover =="
  DOSE_CRASH_AFTER=$POINT DOSE_CRASH_SEQ=2 \
    node cli.js exec --plan plan.json --journal "$WORK/$POINT/j" --out "$WORK/$POINT/out" > /dev/null 2>&1
  echo "killed (exit=$?)"
  node cli.js recover --journal "$WORK/$POINT/j" > /dev/null
  GOT=$(node -e "
const fs=require('fs');
const t=fs.readFileSync('$WORK/$POINT/out/dose_ledger.jsonl','utf8').trim().split('\n')
  .map(JSON.parse).reduce((a,e)=>a+e.dose,0);
console.log(t);")
  echo "recovered total dose: $GOT"
  if [ "$GOT" = "$REF_TOTAL" ]; then
    echo "OK: matches reference"
  else
    echo "FAIL: $GOT != $REF_TOTAL"; exit 1
  fi
done
echo "all acceptance checks passed"
