# repair-order-vcs

离线维修工单版本库及 CLI。Node.js 22，仅标准库与 `node:test`，无第三方依赖。

工单结构：`{id, status, assignee, priority}`。

状态机：`created -> assigned -> in_progress -> done`；`canceled` 可从前三态进入；`done` / `canceled` 为终态，不可再改。

## CLI

```sh
node index.js merge-orders --base base.json --local local.json --remote remote.json --out r.json
node index.js diff --base base.json --target target.json [--out patch.json]
node index.js apply --orders orders.json --patch patch.json [--out result.json]
node index.js undo  --orders orders.json --patch patch.json [--out result.json]
node index.js redo  --orders orders.json --patch patch.json [--out result.json]
```

退出码：`0` 成功；`1` 合并冲突；`2` 未知工单或非法补丁。

## 库（lib/orders.js）

- `diffOrders(base, target)`：生成补丁 `{changes: [{id, field, from, to}]}`。
- `applyPatch(orders, patch)`：应用补丁，校验状态机。
- `undoPatch(orders, patch)`：按逆补丁恢复（逆序、from/to 互换）。
- `redoPatch(orders, patch)`：重放补丁，受状态机约束。
- `mergeOrders(base, local, remote)`：三方合并。不同工单自动合并；同工单不同字段合并；同字段两侧不同则冲突；合并后状态迁移非法、或任一来源修改终态工单，均为冲突（抛 `MergeConflict`，`exitCode = 1`）。

## 测试

```sh
node --test
```

覆盖：4 种线性状态全部 16 种迁移与独立状态机对照、canceled/终态规则、apply/undo/redo、三条合并验收场景、CLI 退出码。
