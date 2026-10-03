#!/usr/bin/env bash
# Regenerates result.txt with real CLI output of the three acceptance scenarios.
set -uo pipefail
cd "$(dirname "$0")/.."

cp examples/demo/catalog.initial.json examples/demo/catalog.json
node -e "require('node:fs').rmSync('examples/demo/plans.json', { force: true })"

{
  echo '================================================================'
  echo 'SCENARIO 1: stats change crosses the join-order threshold'
  echo '  -> plan changes, results identical (hash delta: unchanged)'
  echo '================================================================'
  echo
  echo '$ node src/cli.js explain --db examples/demo --query examples/q1.json'
  node src/cli.js explain --db examples/demo --query examples/q1.json
  echo
  echo '$ node src/cli.js execute --db examples/demo --query examples/q1.json'
  node src/cli.js execute --db examples/demo --query examples/q1.json
  echo
  echo '$ node src/cli.js update-stats --db examples/demo --table orders --stats examples/stats-orders.json'
  node src/cli.js update-stats --db examples/demo --table orders --stats examples/stats-orders.json
  echo
  echo '$ node src/cli.js execute --db examples/demo --query examples/q1.json   (re-execute after stats update)'
  node src/cli.js execute --db examples/demo --query examples/q1.json
  echo
  echo
  echo '================================================================'
  echo 'SCENARIO 2: left join whose padded column is referenced by a'
  echo '  predicate must NOT be reordered/rewritten into an inner join'
  echo '================================================================'
  echo
  echo '$ node src/cli.js explain --db examples/demo --query examples/q2.json'
  node src/cli.js explain --db examples/demo --query examples/q2.json
  echo
  echo '$ node src/cli.js execute --db examples/demo --query examples/q2.json'
  node src/cli.js execute --db examples/demo --query examples/q2.json
  echo
  echo
  echo '================================================================'
  echo 'SCENARIO 3: invalid queries return errors'
  echo '  (unknown column / nested aggregate)'
  echo '================================================================'
  echo
  echo '$ node src/cli.js explain --db examples/demo --query examples/q3a.json'
  node src/cli.js explain --db examples/demo --query examples/q3a.json
  echo "exit code: $?"
  echo
  echo '$ node src/cli.js explain --db examples/demo --query examples/q3b.json'
  node src/cli.js explain --db examples/demo --query examples/q3b.json
  echo "exit code: $?"
} > result.txt 2>&1

echo "wrote result.txt"
