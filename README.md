# margin-freeze-merge

保证金冻结合并库与 CLI。仅使用 Node.js 22 标准库，测试基于 `node:test`。

## 模型

- 状态按证券维护：`available`（可用保证金）、`frozen`（冻结列表）、`tombstones`（释放墓碑）。
- 事件日志按事件 ID 幂等：完全相同的事件重放为 no-op；同 ID 不同载荷返回 `event-conflict`。
- `freeze` 事件含 `freezeId`、证券、金额；可用额不足返回 `insufficient-margin`。
- `release` 事件引用 `freezeId`，可部分释放；累计释放超过冻结金额返回 `over-release`，未知冻结返回 `unknown-freeze`。
- 冻结被全部释放后移入墓碑：陈旧重复事件幂等忽略，新释放事件返回 `over-release`，不会复活冻结。
- `merge` 将另一副本的事件日志按 ID 排序后确定性重放，并发冻结的冻结额相加，双向合并收敛。
- 证书包含证券、可用额、冻结列表与释放哈希（对 `[freezeId, released]` 排序表的 SHA-256）。

## CLI

状态文件通过 `--state <file>` 或环境变量 `MARGIN_STATE` 指定（默认 `state.json`）。

```sh
node cli.js --state s.json credit <eventId> <symbol> <amount>   # 存入保证金
node cli.js --state s.json freeze <eventId> <symbol> <amount>   # 冻结（freezeId = eventId）
node cli.js --state s.json release <eventId> <freezeId> <amount>
node cli.js --state s.json merge <otherFile>
node cli.js --state s.json position <symbol>
node cli.js --state s.json cert [symbol]
```

所有输出为单行 JSON；错误输出 `{"error":"code"}` 且退出码为 1。

## 测试

```sh
node --test --test-reporter spec
```
