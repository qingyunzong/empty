# RESULTS

环境：Node.js v22.22.1，仅标准库 + `node:test`，单机离线，无网络、无第三方依赖。

## 测试命令与真实输出

`node --test test/*.test.js`（退出码 0）：

```
TAP version 13
# Subtest: test/cert.test.js
ok 1 - test/cert.test.js
  ---
  duration_ms: 2022.381938
  type: 'test'
  ...
# Subtest: test/model.test.js
ok 2 - test/model.test.js
  ---
  duration_ms: 26203.492505
  type: 'test'
  ...
# Subtest: test/store.test.js
ok 3 - test/store.test.js
  ---
  duration_ms: 2085.079044
  type: 'test'
  ...
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 26469.14092
```

各文件子测试（均 ok）：

```
test/model.test.js
ok 1 - exhaustive enumeration of all sequences up to length 5 matches reference
ok 2 - random sequences up to length 10 match reference
ok 3 - random 300-event log with voids: project matches reference and invariants hold
ok 4 - guard error codes: dangling 30, duplicate/over refund 31, frozen 32
ok 5 - refund with insufficient frozen rolls back entirely (no partial mutation)
ok 6 - refundVoid only voids the most recent active refund

test/store.test.js
ok 1 - crash after balance commit, before frozen commit: recovery rolls back both sides
ok 2 - recovery is a no-op after a clean commit
ok 3 - two concurrent refunds on one sale: exactly one wins, loser gets conflict certificate
ok 4 - rejected commit writes nothing

test/cert.test.js
ok 1 - cert is recomputable offline from the event log
ok 2 - guard CLI rejects invalid event with exit 1 and certificate
```

## 验收对照

1. **随机 300 事件（含撤销）+ 状态机枚举对照**：`test/model.test.js`
   - 7 种事件字母表上长度 ≤5 的全部序列（19,607 条）逐事件与独立参考状态机
     （`test/refmodel.js`，不复用库代码、每次重扫历史计算已退额）对照，
     接受/拒绝及错误码、终态账户完全一致；
   - 8,000 条长度 ≤10 的随机序列同样对照通过；
   - 种子固定的 300 事件随机日志（含 refundVoid）：`project` 与参考机一致，
     不变式 `0 <= frozen <= balance` 成立，CLI `project` 输出与库一致。
2. **崩溃恢复**：`test/store.test.js` 用例 1 — 在 balance.json 落盘、frozen.json
   未落盘之间注入崩溃（崩溃瞬间两侧文件确实不一致：60/100），`recover()` 依据
   WAL 日志将两侧一致回滚到事务前状态（100/100），恢复后同一退款可正常提交。
3. **并发退款冲突**：`test/store.test.js` 用例 3 — 同一 sale(100) 上两路各 60 的
   refund 对同一基准哈希均通过 guard；第一路提交成功，第二路因基准哈希变化
   被判冲突并返回冲突证书（code=31，含 expectedHash/actualHash）；对新状态重试
   仍为 code=31，最终 `refunded=60`，不自动拆分。
4. **终态 cert 离线重算**：`test/cert.test.js` 用例 1 — 测试内用独立参考投影 +
   独立 canonical 实现从事件日志重算每账户哈希与总体哈希，与
   `node cli.js cert` 输出完全一致，且两次运行结果相同（确定性）。

## CLI 冒烟（真实输出摘录）

```
$ node cli.js guard demo.jsonl '{"type":"refund","id":"r2","saleId":"ghost","account":"bob","amount":5}'
{
  "ok": false,
  "code": 30,
  "reason": "refund references unknown sale ghost",
  "certificate": { "code": 30, ..., "stateHash": "218b81e0..." }
}
退出码 1；合法事件退出码 0 输出 {"ok": true}。
```
