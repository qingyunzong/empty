#!/usr/bin/env bash
# CLI end-to-end test: load/recall/revoke/prove/audit + error codes.
# Run: bash test/cli.e2e.sh   (from repo root)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/cli.js"
D="$(mktemp -d)"
STORE="$D/store.json"
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); echo "ok $1 - $2"; }
bad()  { FAIL=$((FAIL+1)); echo "not ok $1 - $2"; }
check(){ # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$T" "$1"; else bad "$T" "$1 (expected=$2 actual=$3)"; fi
}
T=0

cat > "$D/b1.json" <<'JSON'
{"batchId":"B1","docs":[
 {"id":"D1","description":"缸体表面裂纹扩展明显","defectCode":"CRK01","batchCode":"LOT100"},
 {"id":"D2","description":"密封圈渗漏","defectCode":"LEA01","batchCode":"LOT101"}]}
JSON
cat > "$D/b2.json" <<'JSON'
{"batchId":"B2","docs":[
 {"id":"D3","description":"轴承裂纹 扩展趋势","defectCode":"CRK02","batchCode":"LOT100"},
 {"id":"D4","description":"齿轮点蚀","defectCode":"PIT01","batchCode":"CRK01"}]}
JSON

T=1; OUT=$(node "$CLI" --store "$STORE" load "$D/b1.json"); RC=$?
check "load B1 exit 0" 0 $RC
check "load B1 epoch 1" 1 "$(echo "$OUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).epoch))')"

T=2; node "$CLI" --store "$STORE" load "$D/b1.json" 2>"$D/err"; RC=$?
check "duplicate batch exit 3 (E_DUP)" 3 $RC
check "stderr shows E_DUP" 0 "$(grep -c E_DUP "$D/err" >/dev/null; echo $?)"

T=3; node "$CLI" --store "$STORE" load "$D/b2.json" >/dev/null
OUT=$(node "$CLI" --store "$STORE" recall --phrase "裂纹 扩展" --name RC1)
check "recall created" "true" "$(echo "$OUT" | node -pe 'JSON.parse(require("fs").readFileSync(0)).created')"
check "recall hits D1,D3" '["D1","D3"]' "$(echo "$OUT" | node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0)).hits)')"

T=4; OUT2=$(node "$CLI" --store "$STORE" recall --phrase "裂纹  扩展")
check "repeat recall idempotent" "false" "$(echo "$OUT2" | node -pe 'JSON.parse(require("fs").readFileSync(0)).created')"
check "same recall id" "RC1" "$(echo "$OUT2" | node -pe 'JSON.parse(require("fs").readFileSync(0)).recallId')"
check "epoch unchanged" "$(echo "$OUT" | node -pe 'JSON.parse(require("fs").readFileSync(0)).epoch')" "$(echo "$OUT2" | node -pe 'JSON.parse(require("fs").readFileSync(0)).epoch')"

T=5; OUT=$(node "$CLI" --store "$STORE" prove RC1)
check "prove hits" '["D1","D3"]' "$(echo "$OUT" | node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0)).hits)')"

T=6; node "$CLI" --store "$STORE" load --delete B2 >/dev/null
OUT=$(node "$CLI" --store "$STORE" prove RC1)
check "old proof still proves after delete" '["D1","D3"]' "$(echo "$OUT" | node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0)).hits)')"
OUT=$(node "$CLI" --store "$STORE" recall --phrase "裂纹 扩展")
check "new recall excludes deleted batch" '["D1"]' "$(echo "$OUT" | node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0)).hits)')"

T=7; node "$CLI" --store "$STORE" revoke RC1 2>"$D/err"; RC=$?
check "revoke blocked after later ops -> exit 2 (E_EPOCH)" 2 $RC
check "stderr shows E_EPOCH" 0 "$(grep -c E_EPOCH "$D/err" >/dev/null; echo $?)"

T=8; LATEST=$(node "$CLI" --store "$STORE" audit | node -pe 'const r=JSON.parse(require("fs").readFileSync(0)); r.entries.filter(e=>e.type==="RECALL").at(-1).payload.recallId')
OUT=$(node "$CLI" --store "$STORE" revoke "$LATEST")
check "revoke latest recall restores epoch" "true" "$(echo "$OUT" | node -pe 'const o=JSON.parse(require("fs").readFileSync(0)); String(Number.isInteger(o.restoredEpoch))')"
node "$CLI" --store "$STORE" revoke "$LATEST" 2>"$D/err"; RC=$?
check "double revoke -> exit 3 (E_DUP)" 3 $RC

T=9; OUT=$(node "$CLI" --store "$STORE" audit)
check "audit chain ok" "true" "$(echo "$OUT" | node -pe 'String(JSON.parse(require("fs").readFileSync(0)).ok)')"
check "audit shows RECALL before REVOKE" "true" "$(echo "$OUT" | node -pe 'const e=JSON.parse(require("fs").readFileSync(0)).entries; String(e.findIndex(x=>x.type==="REVOKE")>e.findIndex(x=>x.type==="RECALL"))')"
check "revoke references recall hash (causal link)" "true" "$(echo "$OUT" | node -pe 'const e=JSON.parse(require("fs").readFileSync(0)).entries; const rv=e.find(x=>x.type==="REVOKE"); const rc=e.find(x=>x.type==="RECALL"&&x.payload.recallId===rv.payload.recallId); String(rv.payload.recallHash===rc.hash)')"

T=10; node -e '
const fs=require("fs");
const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
s.audit=s.audit.filter(e=>e.type!=="REVOKE");   // rewrite history: revoke never happened
fs.writeFileSync(process.argv[1],JSON.stringify(s));
' "$STORE"
node "$CLI" --store "$STORE" audit 2>"$D/err" >/dev/null; RC=$?
check "tampered history -> audit exit 4 (E_PROOF)" 4 $RC
check "stderr shows E_PROOF" 0 "$(grep -c E_PROOF "$D/err" >/dev/null; echo $?)"
node "$CLI" --store "$STORE" prove "$LATEST" 2>"$D/err" >/dev/null; RC=$?
check "tampered history -> prove exit 4 (E_PROOF)" 4 $RC

echo "---"
echo "# pass $PASS"
echo "# fail $FAIL"
[ "$FAIL" -eq 0 ]
