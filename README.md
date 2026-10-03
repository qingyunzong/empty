# lot-freeze

单机离线批次冻结影响范围判定库与 CLI。仅依赖 Node.js 22 标准库。

## 模型

- 边方向：child 指向 parent(`{ child, parent }`)。
- `supplier` 冻结沿下游传播到所有衍生批次；`customer` 冻结沿上游传播到所有来源批次。
- 有效严重度取数值最大值；任一来源 hold 的 severity 为 `null` 时结果为 `null`(未知但仍冻结)。
- `reasons` 保留所有触发 hold 的 id。
- 图谱存在环时输入非法,在任何事务处理前报错,不产生部分结果。
- hold/release 为增量事务,每次事务后重算闭包;`undo` 可恢复最近一次 hold 或 release。

## 用法

```sh
node src/cli.js load graph.json            # graph.json: { "lots": [...], "edges": [{ "child", "parent" }] }
node src/cli.js hold h1 A supplier 3       # severity 为数字或 null
node src/cli.js release h1
node src/cli.js query M                    # => { "lot", "frozen", "severity", "reasons" }
node src/cli.js undo
```

状态持久化在 `.freeze-state.json`(可用 `--state <path>` 或 `FREEZE_STATE_FILE` 覆盖)。

## 测试

```sh
node --test
```
