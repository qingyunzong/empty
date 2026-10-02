#!/usr/bin/env bash
# 用真实 CLI 跑三个验收场景，输出写入 result.txt
set -u
cd "$(dirname "$0")"
DB=/tmp/trace-scenario-db.json
rm -f "$DB"
OUT=result.txt
: > "$OUT"
say()  { printf '%s\n' "$*" | tee -a "$OUT"; }
run()  { say "\$ $*"; "$@" 2>&1 | tee -a "$OUT"; }

say "=== 场景1: split 后 merge，双向可达枚举 ==="
run node src/cli.js --db "$DB" commit '{"id":"tx-build","corrections":[
 {"kind":"edge","old":null,"new":{"child":"B","parent":"A","quantity":2}},
 {"kind":"edge","old":null,"new":{"child":"C","parent":"A","quantity":3}},
 {"kind":"edge","old":null,"new":{"child":"D","parent":"B","quantity":1}},
 {"kind":"edge","old":null,"new":{"child":"D","parent":"C","quantity":1}},
 {"kind":"edge","old":null,"new":{"child":"E","parent":"D","quantity":5}}]}'
say "--- 正向：E 的上游根集合 ---"
run node src/cli.js --db "$DB" trace E
say "--- 逆向：A 的下游叶集合 ---"
run node src/cli.js --db "$DB" trace A

say ""
say "=== 场景2: 上游 null 检验更正为 block，uninspected -> blocked ==="
run node src/cli.js --db "$DB" commit '{"id":"tx-null-insp","corrections":[
 {"kind":"inspection","old":null,"new":{"lot":"A","result":null,"ts":1}}]}'
say "--- 更正前（A 仅 null 记录） ---"
run node src/cli.js --db "$DB" trace E
run node src/cli.js --db "$DB" commit '{"id":"tx-fix","corrections":[
 {"kind":"inspection","old":{"lot":"A","result":null,"ts":1},"new":{"lot":"A","result":"block","ts":2}}]}'
say "--- 更正后（A 为 block） ---"
run node src/cli.js --db "$DB" trace E
say "--- 撤销 tx-fix，恢复 uninspected ---"
run node src/cli.js --db "$DB" undo tx-fix
run node src/cli.js --db "$DB" trace E

say ""
say "=== 场景3: 撤销不存在事务报错；重复撤销幂等 ==="
run node src/cli.js --db "$DB" undo no-such-tx
run node src/cli.js --db "$DB" undo tx-fix
run node src/cli.js --db "$DB" trace E
