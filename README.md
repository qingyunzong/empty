# tx-undo

交易树撤销工具：对 `reason` 建位置索引，支持有序近邻查询（ordered near / slop），
并在给定根子树内按预算整批撤销命中节点及其后代，产出补偿批次号与证书。
仅依赖 Node.js 22 标准库，测试使用 `node:test`，全程单机离线。

## 数据模型

节点字段：`id`、`parentId`、`amount`、`reason`、`state`（`active` / `undone`）。
数据文件为 JSON 数组或 `{ "nodes": [...] }`。

## 库函数（src/lib.js）

- `PositionalIndex.fromNodes(nodes)` / `index.near(first, second, slop)`
  有序近邻查询：`first` 在 `second` 之前，且 `pos2 - pos1 - 1 <= slop`；
  返回 `Map(nodeId -> [[pos1, pos2], ...])`。
- `planUndo(nodes, { rootId, terms, slop, budget })`
  纯规划：校验根存在、父链无环、无重复撤销、预算充足，返回确定的撤销集合。
- `undo(store, nodes, options)`：规划 + 原子落盘，返回证书。
- `StateStore`：原子状态存储（tmp + rename + fsync）。
- 错误码：`ROOT_NOT_FOUND`、`CYCLE_DETECTED`、`ALREADY_UNDONE`、
  `BUDGET_EXCEEDED`、`DUPLICATE_NODE`、`CORRUPT_STATE`、`BAD_REQUEST`。

## 撤销语义

- 命中集合 = 根子树内 `reason` 满足有序近邻的节点；并列按节点 id 字典序处理，
  撤销集合为命中节点及其全部后代的并集，结果完整确定。
- 总金额为撤销集合 amount 之和，超过预算则整批失败，无任何副作用。
- 证书包含：批次号、根、词项对、slop、预算、总金额，以及每个节点的
  id、层级（相对根的深度）、金额、是否直接命中、查询位置对。

## 状态文件与崩溃恢复

状态目录布局：

```
<state-dir>/batches/<n>.json   # 批次快照（tmp 写入 + rename + fsync）
<state-dir>/COMMIT             # 提交标记：最新已提交批次号
```

先写批次快照，最后写 `COMMIT` 标记。重启加载时只认 `COMMIT` 指向的批次；
标记缺失（崩溃发生在两次写入之间）则该批次视为未撤销。

## CLI

```sh
node bin/cli.js query  --data data.json --root R --terms "foo bar" --slop 1
node bin/cli.js undo   --data data.json --root R --terms "foo bar" --slop 1 \
                       --budget 100 --state-dir .state
node bin/cli.js status --state-dir .state
```

成功时 JSON 写 stdout、退出码 0；失败时 `{"error":{code,message,details}}`
写 stderr、退出码 1。

## 测试

```sh
node --test
```

覆盖：索引结果与枚举全部有序窗口的暴力参考实现交叉验证（200 轮随机）、
预算充足时父子一起撤销且金额正确、预算不足/父链成环/重复撤销均无副作用、
COMMIT 标记缺失时重启视为未撤销、CLI 退出码与输出。
