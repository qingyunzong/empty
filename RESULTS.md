# RESULTS — 真实测试输出

环境：Node.js v22.22.1，仅标准库 + `node:test`，单机离线。
日期：2026-10-03（Asia/Shanghai）。

## 1. 单元与集成测试：`node --test test/*.test.js`

覆盖：scan 增/改/删捕获、apply 幂等、后写覆盖、重复撤销冲突标记、跨批回指、
负余额/非整数金额拒绝、缺行/坏哈希退出码 2 + JSON stderr、n≤12 全序重放对照、
1 万行 3 次崩溃恢复哈希一致。

```
TAP version 13
# Subtest: test/apply.test.js
ok 1 - test/apply.test.js
  ---
  duration_ms: 4603.5026
  type: 'test'
  ...
# Subtest: test/crash.test.js
ok 2 - test/crash.test.js
  ---
  duration_ms: 20616.094883
  type: 'test'
  ...
# Subtest: test/errors.test.js
ok 3 - test/errors.test.js
  ---
  duration_ms: 6913.359796
  type: 'test'
  ...
# Subtest: test/permutation.test.js
ok 4 - test/permutation.test.js
  ---
  duration_ms: 20825.4303
  type: 'test'
  ...
# Subtest: test/scan.test.js
ok 5 - test/scan.test.js
  ---
  duration_ms: 3894.388854
  type: 'test'
  ...
1..5
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 21406.037208
```

## 2. 真实 kill -9 端到端：`bash scripts/e2e_crash.sh`

1 万行日志，随机注入 3 次 `kill -9`（写库后未写 checkpoint × 1、checkpoint 写后
× 1、cert 写前 × 1），恢复后与一次性运行比对 Merkle 根 / 状态哈希 / DB 字节。

```
workspace: /tmp/e2e-crash-7xZNT4sT  rows=10000 batch=500 batches=20
journal generated: 10000 rows
--- one-shot reference run (dir a) ---
{"command":"scan","added":10000,"modified":0,"deleted":0,"total":10000,"entries":10000}
{"command":"apply","status":"ok","redone":20,"committedBatches":20,"batchCount":20,"merkleRoot":"630d0222655189343492f1bd0742cf13454abf60cf97b3503bf2522c914583a6","coverage":[1,10000]}
--- crashed run (dir b): 3x kill -9 at random points ---
{"command":"scan","added":10000,"modified":0,"deleted":0,"total":10000,"entries":10000}
random crash points: db:7 checkpoint:14 cert:0
kill -9 #1 injected at db:7 (exit code 137)
kill -9 #2 injected at checkpoint:14 (exit code 137)
kill -9 #3 injected at cert:0 (exit code 137)
--- final resume ---
{"command":"resume","status":"already-committed","redone":0,"committedBatches":20,"batchCount":20,"merkleRoot":"630d0222655189343492f1bd0742cf13454abf60cf97b3503bf2522c914583a6","coverage":[1,10000]}
--- comparison ---
one-shot  merkleRoot: 630d0222655189343492f1bd0742cf13454abf60cf97b3503bf2522c914583a6
recovered merkleRoot: 630d0222655189343492f1bd0742cf13454abf60cf97b3503bf2522c914583a6
one-shot  stateHash : 0402c74ae3421ae31d64814089a31977ec343841c71607974d21fc8d1b52e8a3
recovered stateHash : 0402c74ae3421ae31d64814089a31977ec343841c71607974d21fc8d1b52e8a3
coverage            : [1,10000] batches: 20 rows: 10000
E2E RESULT: PASS (recovered hash == one-shot hash, db byte-identical)
```

## 3. CLI 会话实录：scan / apply / resume / cert

```
$ node cli.js scan --journal journal.ndjson --snapshot snap.json --changeset cs.json
{"command":"scan","added":5,"modified":0,"deleted":0,"total":5,"entries":5}
$ node cli.js apply --changeset cs.json --db db.json --checkpoint cp.json --cert cert.json --batch 2
{"command":"apply","status":"ok","redone":3,"committedBatches":3,"batchCount":3,"merkleRoot":"19bf87c794ab73f0b94e66a91f1d7a180bcace74bd9e4e41859ab0ae861f2371","coverage":[1,5]}
$ node cli.js resume --changeset cs.json --db db.json --checkpoint cp.json --cert cert.json --batch 2
{"command":"resume","status":"already-committed","redone":0,"committedBatches":3,"batchCount":3,"merkleRoot":"19bf87c794ab73f0b94e66a91f1d7a180bcace74bd9e4e41859ab0ae861f2371","coverage":[1,5]}
$ node cli.js cert --checkpoint cp.json --db db.json --cert cert2.json
{"command":"cert","version":1,"merkleRoot":"19bf87c794ab73f0b94e66a91f1d7a180bcace74bd9e4e41859ab0ae861f2371","coverage":[1,5],"batchCount":3,"rowCount":5,"stateHash":"1c230765759eff99e9dac467159f632036b628f1759153dc0e68e2ea8b539cfb"}
$ cat cert.json
{
  "version": 1,
  "merkleRoot": "19bf87c794ab73f0b94e66a91f1d7a180bcace74bd9e4e41859ab0ae861f2371",
  "coverage": [
    1,
    5
  ],
  "batchCount": 3,
  "rowCount": 5,
  "stateHash": "1c230765759eff99e9dac467159f632036b628f1759153dc0e68e2ea8b539cfb"
}
$ # duplicate-undo conflict marker in db state:
{"balances":{"cash":98500},"conflicts":[{"txId":"u2","ref":"t2","code":"DUPLICATE_UNDO"}],"undone":["t2"]}
```

## 4. 错误路径实录：缺行 / 坏哈希 / 负余额 → 退出码 2 + stderr JSON

```
$ node cli.js scan --journal gap.ndjson ...   # seq 缺行
{"error":{"code":"MISSING_LINE","message":"seq gap at line 2: expected 2, got 3","details":{"line":2,"expected":2,"got":3}}}
exit=2
$ node cli.js apply ...   # 篡改记录导致坏哈希
{"error":{"code":"HASH_MISMATCH","message":"changeset entry 0 hash mismatch: expected 8f413a7701485a105c5a2655bff1c02f485cb60dca8552f341243731de91629a, got 899fe9eab3aa92509b97a99b20b09bea3fb35ce5050277226e90ac54693cde43","details":{"entry":0,"txId":"a","expected":"8f413a7701485a105c5a2655bff1c02f485cb60dca8552f341243731de91629a","got":"899fe9eab3aa92509b97a99b20b09bea3fb35ce5050277226e90ac54693cde43"}}}
exit=2
$ node cli.js apply ...   # 负余额
{"error":{"code":"NEGATIVE_BALANCE","message":"account x has negative balance -50","details":{"account":"x","balance":-50}}}
exit=2
```
