#!/usr/bin/env bash
# Regenerates result.txt with the real CLI output of the three scenarios.
set -u
cd "$(dirname "$0")/.."
OUT=result.txt
{
  echo '=== Scenario 1: stats change crosses the join-order threshold (plan changes, result identical) ==='
  echo
  echo '$ node cli.js explain --catalog examples/scenario1/catalog.json --query examples/scenario1/query.json'
  node cli.js explain --catalog examples/scenario1/catalog.json --query examples/scenario1/query.json
  echo
  echo '$ node cli.js update-stats --catalog examples/scenario1/catalog.json --data examples/scenario1/data.json --query examples/scenario1/query.json --table c --stats examples/scenario1/stats-update.json'
  node cli.js update-stats --catalog examples/scenario1/catalog.json --data examples/scenario1/data.json --query examples/scenario1/query.json --table c --stats examples/scenario1/stats-update.json
  echo
  echo '=== Scenario 2: left join with predicate on the null-padded column (no inner-join rewrite) ==='
  echo
  echo '$ node cli.js explain --catalog examples/scenario2/catalog.json --query examples/scenario2/query.json'
  node cli.js explain --catalog examples/scenario2/catalog.json --query examples/scenario2/query.json
  echo
  echo '$ node cli.js execute --catalog examples/scenario2/catalog.json --data examples/scenario2/data.json --query examples/scenario2/query.json'
  node cli.js execute --catalog examples/scenario2/catalog.json --data examples/scenario2/data.json --query examples/scenario2/query.json
  echo
  echo '=== Scenario 3: illegal queries return errors ==='
  echo
  echo '$ node cli.js explain --catalog examples/scenario3/catalog.json --query examples/scenario3/query-unknown-column.json'
  node cli.js explain --catalog examples/scenario3/catalog.json --query examples/scenario3/query-unknown-column.json 2>&1
  echo "exit code: $?"
  echo
  echo '$ node cli.js explain --catalog examples/scenario3/catalog.json --query examples/scenario3/query-nested-aggregate.json'
  node cli.js explain --catalog examples/scenario3/catalog.json --query examples/scenario3/query-nested-aggregate.json 2>&1
  echo "exit code: $?"
} > "$OUT" 2>&1
echo "wrote $OUT"
