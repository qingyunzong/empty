# credit-hold-ledger

支付侧持卡人额度授权账本：授权冻结、部分解冻、撤销、结算扣减。
纯 Node.js 22 标准库实现，无外部依赖。

## 模型

- 事件全序：`(seq, requestId)`——并发事件按到达序号排序，平局以请求 ID 决胜，
  任意输入排列重放结果一致（确定性重算）。
- 依赖图（差分维护）：`authorize → 账户 held → available`；`capture → 账户 captured → merchant settled`。
  每次应用只增量更新受影响节点，并在 journal 中记录 before/after delta（事件溯源，解释每次变化来源）。
- 失效传播：`void` 后同一 `authId` 可复用，旧代（generation）节点标记 `invalidated`，新授权开启新一代。
- 业务拒绝（`INSUFFICIENT` / `EXCEEDS_HOLD` / `NO_ACTIVE_AUTH` / `DUPLICATE_AUTH` / `NO_ACCOUNT`）
  不产生任何部分状态，仅记入 journal。

## 不变式

- 冻结不得超过可用额：`available = limit - held - captured`，超额授权返回 `INSUFFICIENT`。
- 解冻/捕获金额不得超过该授权剩余冻结额，否则 `EXCEEDS_HOLD`。
- 撤销已部分结算的授权：保留已捕获金额，释放剩余冻结。

## CLI

```sh
# 应用 JSONL 事件流（stdin 或 --input），追加写日志并 fsync，输出快照+journal
node cli.js run --log events.log < events.jsonl
node cli.js run --log events.log --input events.jsonl

# 从日志恢复并输出账户快照
node cli.js snapshot --log events.log

# 确定性重放前 N 个事件（按全序）
node cli.js replay --log events.log --prefix 10
```

错误（非法 JSON、非法事件、未知命令、IO 失败）写 stderr 并以退出码 4 终止。

崩溃恢复：日志按行 JSON 追加 + fsync；恢复时遇到撕裂/损坏行即截断，
回到最近一次 fsync 的一致状态。

## 事件格式（每行一个 JSON）

```json
{"seq":1,"requestId":"r1","type":"open_account","account":"a1","limit":1000}
{"seq":2,"requestId":"r2","type":"authorize","authId":"au1","account":"a1","amount":400}
{"seq":3,"requestId":"r3","type":"capture","authId":"au1","amount":150,"merchant":"m1"}
{"seq":4,"requestId":"r4","type":"release","authId":"au1","amount":50}
{"seq":5,"requestId":"r5","type":"void","authId":"au1"}
```

## 测试

```sh
node --test
```
