#!/usr/bin/env bash
# End-to-end demo of the fsc-settle CLI. Equivalent to: npm run example
set -uo pipefail
cd "$(dirname "$0")/.."
OUT="$(mktemp -d)"

echo '=== 1. normal settle: three parties, two currencies, nets sum to zero ==='
node src/cli.js settle examples/normal.jsonl --base CNY

echo
echo '=== 2. contradictory rates: infeasibility certificate + independent verify ==='
node src/cli.js settle examples/conflict.jsonl --base CNY --cert-out "$OUT/cert.json"
echo "settle exit=$?"
node src/cli.js verify examples/conflict.jsonl "$OUT/cert.json"
echo "verify exit=$?"

echo
echo '=== 3. missing rate path: E_PENDING (exit 3), never reported as unsatisfiable ==='
node src/cli.js settle examples/pending.jsonl --base CNY
echo "settle exit=$?"

echo
echo '=== 4. undo/correct restore the historical hash (evt:2 == evt:4 == evt:6) ==='
node src/cli.js hash examples/undo.jsonl

echo
echo '=== 5. error codes: E_PARSE=2, E_REF=4 ==='
printf '{"addInvoice":{"id":"A","ccy":"CNY","num":1,"den":0}}\n' > "$OUT/bad.jsonl"
node src/cli.js settle "$OUT/bad.jsonl"; echo "exit=$?"
printf '{"undo":{"eventId":"evt:9"}}\n' > "$OUT/ref.jsonl"
node src/cli.js settle "$OUT/ref.jsonl"; echo "exit=$?"

echo
echo '=== 6. test suite ==='
node --test
