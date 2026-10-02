# RESULTS

运行环境：Node.js v22.22.1（仅标准库 + node:test），单机离线。
日期：2026-10-03。以下全部为真实运行输出。

## 1. 验收测试：`node --test test/*.test.js`

覆盖验收标准：
1. `test/crash.test.js` — 1 万行日志，随机注入 3 次 kill -9（`db:k` / `ckpt:k` / `pre-cert`），恢复后 db 哈希与 Merkle 根等于一次性运行；并分别验证"未提交可重做"（redoneEvents=500）与"已提交不重做"（redoneEvents=0, batches=0）。
2. `test/undo.test.js` — 重复撤销同一交易只生效一次并留 `duplicate-undo` 冲突标记；同事务键后写覆盖前写；重复 apply 幂等。
3. `test/replay.test.js` — 对 n=1..12 枚举全部全序（线性扩展，共 n!/2^k 种，n=12 时为 7,484,400 种）重放，最终余额与对照完全一致。
4. `test/errors.test.js` — 缺行 / 坏哈希 / 坏 JSON / 非整数金额 / 缺日志文件均退出码 2 且 stderr 为 JSON；负余额为错误。

```
TAP version 13
# Subtest: test/crash.test.js
ok 1 - test/crash.test.js
  ---
  duration_ms: 38791.947607
  type: 'test'
  ...
# Subtest: test/errors.test.js
ok 2 - test/errors.test.js
  ---
  duration_ms: 22016.299131
  type: 'test'
  ...
# Subtest: test/replay.test.js
ok 3 - test/replay.test.js
  ---
  duration_ms: 70938.491238
  type: 'test'
  ...
# Subtest: test/scan.test.js
ok 4 - test/scan.test.js
  ---
  duration_ms: 18828.411574
  type: 'test'
  ...
# Subtest: test/undo.test.js
ok 5 - test/undo.test.js
  ---
  duration_ms: 20699.389482
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
# duration_ms 71410.992938
```

## 2. CLI 演示：`node cli.js scan|apply|resume|cert`

演示日志含重复撤销（u1、u2 同时撤销 t2）：

```
$ node cli.js scan --journal journal.ndjson --dir .state
{
  "changesetId": "866576bf8a7348f14b2321fb34a8fc4a03438e15d2ad7ae2b186dc3eca32b95d",
  "events": 5,
  "journalHash": "7984328e563ac0db10e9574472b8a7059d04b20785b094f0f4fe5a5ccc36ab8c"
}

$ node cli.js apply --journal journal.ndjson --dir .state --batch 2
{
  "changesetId": "866576bf8a7348f14b2321fb34a8fc4a03438e15d2ad7ae2b186dc3eca32b95d",
  "redoneEvents": 0,
  "appliedEvents": 5,
  "batches": 3,
  "committedSeq": 5,
  "cert": {
    "merkleRoot": "d27ddc0b1cd918d78e25f4d92621e8f5168e83819c6dd0b2ce750ea697d0a8dc",
    "from": 1,
    "to": 5,
    "batches": 3,
    "committedSeq": 5,
    "rowHash": "5d69fa7f2e06a88be5690afedf718653f0206f94d7068748631974fc43391b79",
    "changesetId": "866576bf8a7348f14b2321fb34a8fc4a03438e15d2ad7ae2b186dc3eca32b95d"
  }
}

$ node cli.js resume --journal journal.ndjson --dir .state
{
  "changesetId": "866576bf8a7348f14b2321fb34a8fc4a03438e15d2ad7ae2b186dc3eca32b95d",
  "redoneEvents": 0,
  "appliedEvents": 0,
  "batches": 0,
  "committedSeq": 5,
  "cert": {
    "merkleRoot": "d27ddc0b1cd918d78e25f4d92621e8f5168e83819c6dd0b2ce750ea697d0a8dc",
    "from": 1,
    "to": 5,
    "batches": 3,
    "committedSeq": 5,
    "rowHash": "5d69fa7f2e06a88be5690afedf718653f0206f94d7068748631974fc43391b79",
    "changesetId": "866576bf8a7348f14b2321fb34a8fc4a03438e15d2ad7ae2b186dc3eca32b95d"
  }
}

$ node cli.js cert --journal journal.ndjson --dir .state
{
  "merkleRoot": "d27ddc0b1cd918d78e25f4d92621e8f5168e83819c6dd0b2ce750ea697d0a8dc",
  "from": 1,
  "to": 5,
  "batches": 3,
  "committedSeq": 5,
  "rowHash": "5d69fa7f2e06a88be5690afedf718653f0206f94d7068748631974fc43391b79",
  "changesetId": "866576bf8a7348f14b2321fb34a8fc4a03438e15d2ad7ae2b186dc3eca32b95d"
}

$ cat .state/db.json
{
  "accounts": {
    "cash": 16700,
    "revenue": 0
  },
  "conflicts": [
    {
      "row": "u2",
      "target": "t2",
      "reason": "duplicate-undo"
    }
  ],
  "undone": {
    "t2": {
      "by": "u1",
      "account": "revenue",
      "amount_cents": 7300
    }
  }
}
```

## 3. 错误路径演示：篡改行哈希 -> 退出码 2 + stderr JSON

```
$ node cli.js scan (then tamper line 2 without rescan)
{
  "changesetId": "c33b83d1b1485c03658b1ec2b72f0eb58a89edde62b35560dceeeec5719788d2",
  "events": 2,
  "journalHash": "1705ed04e77f831af0e101f70ba531c5b27f921e87f1653d66a8eeea8b92d717"
}

$ node cli.js apply --journal journal.ndjson --dir .state
{"error":{"code":"bad-hash","message":"hash mismatch at journal line 2","details":{"line":2,"expected":"3494895c7da974ca086f77bf370c179d8e448731a5cef728df6d8d54176b3885","actual":"d3953ce2952be92c73c4cf2917662e4ffdeb27b10d8b90a91e3278dd90de65e1"}}}
exit code: 2
```
