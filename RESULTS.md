# RESULTS — 组17 退款/额度冻结一致性

环境：Node.js v22.22.1，仅标准库 + node:test，单机离线。
日期：2026-10-03

## 实现

- `lib/model.js` — 事件 guard / apply / project（sale、refund、refundVoid、freeze、unfreeze）。
  refund 与其联动 unfreeze 在同一原子步骤内完成；guard 失败状态零变更。
- `lib/store.js` — balance/freeze 双文件事务存储 + WAL journal；崩溃后 `recover()`
  用 journal 前镜像同时回滚两侧。
- `lib/conflict.js` — 乐观并发（baseSeq）+ 冲突证书；并发超额退款判冲突，不自动拆分。
- `lib/cert.js` — 每账户终态 sha256 + overall 哈希，可从事件日志离线重算。
- `cli.js` — `node cli.js project|guard|cert`（guard 支持 `--apply`，cert 支持 `--out`）。

错误码：30 悬空引用，31 重复退款，32 冻结不足；
内部补充：10 事件畸形，33 退款不可撤销（非最近未消费/已撤销），34 id 重复，
35 冻结余额不足，36 退款余额不足，40 并发冲突。

## 验收对照

| 验收项 | 测试 |
| --- | --- |
| 1) 随机 300 事件含撤销，project 对照参考状态机；n≤10 状态机枚举 | `test/random.test.js`、`test/enumeration.test.js` |
| 2) 崩溃在余额提交后冻结未提交，恢复后两侧一致回滚 | `test/crash.test.js`（真实子进程 `process.exit` 模拟崩溃） |
| 3) 同一 sale 两路并发 refund 只一路成功并给冲突证书 | `test/concurrency.test.js` |
| 4) 终态 cert 可离线重算 | `test/cert.test.js`（测试内独立重实现折叠+哈希比对） |

## 真实测试输出

`node --test test/*.test.js`（exit=0）：

```
TAP version 13
# Subtest: test/cert.test.js
ok 1 - test/cert.test.js
# Subtest: test/cli.test.js
ok 2 - test/cli.test.js
# Subtest: test/concurrency.test.js
ok 3 - test/concurrency.test.js
# Subtest: test/crash.test.js
ok 4 - test/crash.test.js
# Subtest: test/enumeration.test.js
ok 5 - test/enumeration.test.js
# Subtest: test/model.test.js
ok 6 - test/model.test.js
# Subtest: test/random.test.js
ok 7 - test/random.test.js
1..7
# tests 7
# suites 0
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 32397.281368
```

枚举与随机对照的统计（`node test/enumeration.test.js` / `node test/random.test.js` 的诊断输出）：

```
  enumeration: 9846 transitions, 1576 distinct states, reject codes: 35x286 32x263 30x1650 34x3278 31x198 36x89 33x1141
  seed 17: 201/300 applied, 7 refundVoids, rejects: 31x15 35x6 33x35 34x28 32x5 30x10
  seed 1701: 204/300 applied, 10 refundVoids, rejects: 35x8 34x32 33x32 36x1 30x15 31x8
  seed 20261003: 200/300 applied, 8 refundVoids, rejects: 35x2 30x26 34x21 33x42 36x1 31x8
```

枚举覆盖深度 ≤10 的全部可达状态（1576 个），每条迁移上系统与独立参考机的
拒绝码和投影逐项一致；错误码 30/31/32/33/34 均被实际触发。

## CLI 实测

演示日志：sale A=10、sale B=6、freeze A 2、refund r1(s1,4)、refund r2(s1,1)、refundVoid r2。

`node cli.js project --log demo.jsonl`：

```json
{
  "seq": 6,
  "accounts": {
    "A": { "balance": 4, "frozen": 8 },
    "B": { "balance": 6, "frozen": 6 }
  }
}
```

`node cli.js cert --log demo.jsonl`：

```json
{
  "seq": 6,
  "accounts": {
    "A": { "balance": 4, "frozen": 8, "hash": "186b5221a5c97d4dc2a8137bc3c97ed7d947e63b82c163ce6c94361574d0bfdd" },
    "B": { "balance": 6, "frozen": 6, "hash": "c08c1f87259dac59f8bea1264f1c3d9c27ab1a42f0a835578abbdf3f6d398285" }
  },
  "overall": "e6104854cbbfc1b02a4c6e4d9ec6f125fcea997e6fb733bfd8fe67fb09669b29"
}
```

`node cli.js guard --log demo.jsonl --event '{"type":"refund","id":"r9","ref":"ghost","amount":1}'`（exit=1）：

```json
{ "ok": false, "code": 30, "message": "dangling reference: sale ghost not found" }
```

`node cli.js guard --log demo.jsonl --event '{"type":"refund","id":"r8","ref":"s1","amount":9}'`（exit=1）：

```json
{ "ok": false, "code": 31, "message": "duplicate refund: sale s1 already refunded 4/10, requested 9" }
```
