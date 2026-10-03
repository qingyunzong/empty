# offline-planner

离线排产工具：任务调度 + 变更日志位置索引 + 预算耦合的 undo/redo。Node.js 22，仅标准库。

## 数据模型

- 任务：`{id, resources[], start, end, due, budget}`，`delay = max(0, end - due)`，约束 `delay <= budget`。
- 冲突：两任务共享资源且时间区间重叠。
- 变更：`{id, note, op, inverse, window}`，`op ∈ add | remove | shift | deleteNote`，`window` 为涉及任务的时间窗。

## 索引

变更说明（note）建位置倒排索引：拉丁词整词、CJK 单字成词；posting 用**分块 bitset（64 doc/块）+ varint（LEB128，docId/位置均 delta 编码）**压缩。支持：

- 短语查询（位置连续），如 `换模 后 延迟`；
- 近邻查询 `--near k`（全部词项落在跨度 ≤ k 的窗口内）；
- 按任务时间窗过滤 `--from/--to`（与变更 window 相交）。

删除说明（`deleteNote`）后索引整体重建，压缩 posting 不留陈旧 doc，无假阳性。

## undo/redo 与预算耦合

- `undo` 弹出最近变更，先试探性回滚并**重算受影响任务集合**（被触及任务 + 前后状态下共享资源且时间重叠的邻居），若任一受影响任务超预算 → `E_BUDGET`，状态完全不变；产生冲突 → `E_CONFLICT`。
- `redo` 重新应用并同样校验。空栈 → `E_EMPTY`。新变更清空 redo 栈。

## plan 并列最优

`plan` 枚举候选起点（事件边界）与资源方案，主目标最小延迟；并列依次按**资源数少 → 资源列表字典序 → 起点早**确定。

## CLI

```
node cli.js plan   [--state f] [--task '{"id","duration","due","budget","resourceOptions":[[...]]}' --horizon N]
node cli.js change [--state f] --note '换模后延迟' --op '{"type":"shift","taskId":"a","delta":-1}'
node cli.js undo|redo [--state f]
node cli.js query  [--state f] --phrase '换模 后 延迟' [--near k] [--from t --to t]
```

退出码：`E_BUDGET`=2，`E_CONFLICT`=3，`E_EMPTY`=4，用法错误=1。

## 测试

`node --test`（node:test）。覆盖验收：

1. `test/conflicts.test.js` — 扫描线冲突集 vs 全任务对暴力枚举（多种子）；
2. `test/search.test.js` / `test/query-window.test.js` — 短语/近邻/时间窗 vs 暴力文本扫描；
3. `test/undo.test.js` — undo 触发 `E_BUDGET` 状态不变，随后 redo 成功；
4. `test/index-delete.test.js` — 删除说明后压缩 posting 无假阳性。
