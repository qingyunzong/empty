# credit-replica

授信额度副本库与 CLI。Node.js 22，仅标准库与 `node:test`，无第三方依赖。

## 模型

每个副本（一个 JSON 状态文件）维护：

- `limit`：总额度
- `reservations`：预留序列（含部分释放进度），完全释放后保留为**墓碑**（`status: "released"`），防止陈旧重复释放或重放的预留事件将其复活
- `events`：按 `requestId` 索引的事件日志（预留 + 释放）

事件：

- 预留：`{"type":"reserve","requestId":"...","account":"...","amount":N}`
- 释放：`{"type":"release","requestId":"...","reservationId":"<预留 requestId>","amount":N}`，金额不得超过该预留剩余可释放额

幂等性：相同 `requestId` 且载荷相同的事件为幂等无操作；同 ID 不同载荷拒绝（`conflict`）。

## 反熵

- `summary`：状态摘要 = `{limit, digest(sha256), eventIds}`
- `diff`：比较事件 ID 集合，返回对方缺失的事件
- `repair`/`merge`：合入缺失事件；合并时不做额度检查——不同副本的并发预留都必须占用额度（合并后 `available` 可能为负）

## CLI

```sh
node cli.js <state.json> init <limit>
node cli.js <state.json> reserve '{"requestId":"r1","account":"a","amount":100}'
node cli.js <state.json> release '{"requestId":"x1","reservationId":"r1","amount":40}'
node cli.js <state.json> diff <other.json>     # 输出 {"missing":[...事件...]}
node cli.js <state.json> repair <patch.json>   # 合入 diff 输出
node cli.js <state.json> balance               # {"limit","reserved","available"}
node cli.js <state.json> summary               # {"limit","digest","eventIds"}
```

所有输出为单行 JSON；错误输出 `{"error":"code"}` 且退出码为 1。
错误码：`limit-exceeded`、`over-release`、`conflict`、`unknown-reservation`、`invalid-event`、`invalid-json`、`invalid-limit`、`no-such-replica`、`invalid-state`、`no-such-file`、`unknown-command`、`usage`。

## 测试

```sh
node --test --test-reporter spec
```

`test/replica.test.js` 枚举两个副本上预留/释放的有无组合（16 例），用独立参考余额表逐例对照；`test/cli.test.js` 覆盖 CLI 的 JSON 输入输出、错误码与退出码、diff/repair 反熵流程。
