#!/usr/bin/env bash
# End-to-end demo: hierarchy, savepoint, orphan reversal, rollback, boundary.
set -u
cd "$(dirname "$0")/.."

STATE=/tmp/settlement-demo-ledger.json
CLI="node src/cli.js --state $STATE"
node -e "try{require('node:fs').unlinkSync(process.argv[1])}catch{}" "$STATE"

run() {
  echo "\$ $CLI $*"
  $CLI "$@"
  echo
}

run batch create --id G --day 2026-10-01
run batch create --id P --parent G --day 2026-10-01
run batch create --id C --parent P --day 2026-10-01
run tx add --id T1 --batch G --account alice --amount 100 --day 2026-10-01
run savepoint create --id SP1 --batch G
run tx add --id T2 --batch C --account bob --amount 50 --day 2026-10-01
run batch settle --id G
run batch settle --id P
run batch settle --id C

echo "\$ $CLI rollback plan --savepoint SP1   # settled child without reversal"
$CLI rollback plan --savepoint SP1
echo "exit=$?"
echo

run rollback plan --savepoint SP1 --reverse
run rollback exec --savepoint SP1 --reverse
run status

run day close --day 2026-10-01
run tx add --id T3 --batch G --account alice --amount 7 --day 2026-10-02
run savepoint create --id SP2 --batch G
run tx add --id T4 --batch G --account alice --amount 8 --day 2026-10-02
run rollback exec --savepoint SP2

echo "\$ $CLI tx add --id T5 --batch G --account alice --amount 1 --day 2026-10-01   # closed day"
$CLI tx add --id T5 --batch G --account alice --amount 1 --day 2026-10-01
echo "exit=$?"
