#!/usr/bin/env bash
# End-to-end proof with REAL kill -9: 10k rows, 3 random crash injections,
# recovered state must equal a one-shot run. Bash is used because it can
# spawn and signal real OS processes.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d /tmp/e2e-crash-XXXXXXXX)"
ROWS=10000
BATCH=500
BATCHES=$(( (ROWS + BATCH - 1) / BATCH ))
echo "workspace: $WORK  rows=$ROWS batch=$BATCH batches=$BATCHES"

node -e "
const fs = require('node:fs');
const { genJournal } = require('$ROOT/test/helpers.js');
const recs = genJournal(20261003, $ROWS);
fs.writeFileSync('$WORK/journal.ndjson', recs.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log('journal generated:', recs.length, 'rows');
"

mkdir -p "$WORK/a" "$WORK/b"
cp "$WORK/journal.ndjson" "$WORK/a/journal.ndjson"
cp "$WORK/journal.ndjson" "$WORK/b/journal.ndjson"

run() { # dir cmd [extra-env]
  local dir="$1" cmd="$2"
  node "$ROOT/cli.js" "$cmd" \
    --changeset "$dir/cs.json" --db "$dir/db.json" \
    --checkpoint "$dir/cp.json" --cert "$dir/cert.json" --batch "$BATCH"
}

echo '--- one-shot reference run (dir a) ---'
node "$ROOT/cli.js" scan --journal "$WORK/a/journal.ndjson" --snapshot "$WORK/a/snap.json" --changeset "$WORK/a/cs.json"
run "$WORK/a" apply

echo '--- crashed run (dir b): 3x kill -9 at random points ---'
node "$ROOT/cli.js" scan --journal "$WORK/b/journal.ndjson" --snapshot "$WORK/b/snap.json" --changeset "$WORK/b/cs.json"
K1=$(( RANDOM % (BATCHES - 1) ))
K2=$(( K1 + RANDOM % (BATCHES - K1) ))
POINTS=("db:$K1" "checkpoint:$K2" "cert:0")
echo "random crash points: ${POINTS[*]}"
FIRST=1
KILLS=0
for P in "${POINTS[@]}"; do
  if [ "$FIRST" -eq 1 ]; then CMD=apply; FIRST=0; else CMD=resume; fi
  SYNC_CRASH="$P" run "$WORK/b" "$CMD" >/dev/null 2>&1
  RC=$?
  KILLS=$(( KILLS + 1 ))
  echo "kill -9 #$KILLS injected at $P (exit code $RC)"
done
echo '--- final resume ---'
run "$WORK/b" resume

echo '--- comparison ---'
node -e "
const fs = require('node:fs');
const certA = JSON.parse(fs.readFileSync('$WORK/a/cert.json', 'utf8'));
const certB = JSON.parse(fs.readFileSync('$WORK/b/cert.json', 'utf8'));
const dbA = fs.readFileSync('$WORK/a/db.json', 'utf8');
const dbB = fs.readFileSync('$WORK/b/db.json', 'utf8');
console.log('one-shot  merkleRoot:', certA.merkleRoot);
console.log('recovered merkleRoot:', certB.merkleRoot);
console.log('one-shot  stateHash :', certA.stateHash);
console.log('recovered stateHash :', certB.stateHash);
console.log('coverage            :', JSON.stringify(certB.coverage), 'batches:', certB.batchCount, 'rows:', certB.rowCount);
const ok = certA.merkleRoot === certB.merkleRoot && certA.stateHash === certB.stateHash && dbA === dbB;
console.log(ok ? 'E2E RESULT: PASS (recovered hash == one-shot hash, db byte-identical)' : 'E2E RESULT: FAIL');
process.exit(ok ? 0 : 1);
"
