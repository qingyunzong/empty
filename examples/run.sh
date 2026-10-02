#!/usr/bin/env bash
# End-to-end demo of the fx-settle CLI. Equivalent npm script: `npm run example`.
set -euo pipefail
cd "$(dirname "$0")/.."

echo '== 1. settle: feasible, 3 parties / 2 currencies (nets sum to zero) =='
node bin/settle.js settle examples/ok.jsonl --base CNY

echo
echo '== 2. settle: contradictory rates -> infeasible + minimal conflict certificate =='
node bin/settle.js settle examples/conflict.jsonl --base CNY > /tmp/fx-settle-conflict.json || echo "exit=$? (1 = infeasible)"
node -e "const r=require('/tmp/fx-settle-conflict.json');require('fs').writeFileSync('examples/certificate.json',JSON.stringify(r.certificate,null,2)+'\n')"
cat examples/certificate.json

echo
echo '== 3. verify: independent re-check of the certificate =='
node bin/settle.js verify examples/conflict.jsonl examples/certificate.json

echo
echo '== 4. settle: missing rate -> E_PENDING (not infeasible) =='
node bin/settle.js settle examples/pending.jsonl --base CNY || echo "exit=$? (4 = pending)"

echo
echo '== 5. history hash: undo restores the previous hash =='
h1=$(node bin/settle.js hash examples/ok.jsonl)
h2=$(node bin/settle.js hash examples/undo_demo.jsonl)
echo "ok.jsonl        $h1"
echo "undo_demo.jsonl $h2"
[ "$h1" = "$h2" ] && echo 'IDENTICAL (undo restored the history hash)'
