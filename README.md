# explree — 层级预算冻结与回滚核验

Node.js 22 标准库实现（`node:test` / `node:crypto` / `node:fs`），无第三方依赖。

## 库（`src/tree.js`）

预算是一棵有根树，每个节点有 `limit`。子节点持有（hold）额度时，所有祖先的汇总占用同步增加；`cancel`/`release` 沿同一路径精确恢复。

- `new BudgetTree(spec)` — `spec = { nodes: [{ id, parent, limit, frozen? }] }`，要求单根、无重复 id、父引用存在；环、自父、未知父、多根抛 `INVALID_TREE`。
- `reserve(batchId, [{ node, amount }])` — 一批可含多个节点。任一节点余额不足、路径上有冻结节点、节点未知或批次 id 重复时整批拒绝，不产生部分占用。重复批次/余额不足/冻结/未知批次抛 `INVALID_BATCH`，未知节点抛 `INVALID_TREE`。
- `cancel(batchId)` / `release(batchId)` — 撤销整批（`release` 为别名）。
- `settle(batchId)` — 将持有转为已用（held → used），沿同一路径。
- `freeze(nodeId)` / `unfreeze(nodeId)`。
- `read(nodeId)` — 返回 `{ direct: { held, used }, subtree: { held, used }, available, limit, frozen }`，direct 为本节点直接值，subtree 含后代汇总。
- `verifyInvariants()` — 非负、各节点 `subtree(held+used) <= limit`、自顶向下与自底向上两种聚合一致性交叉校验。
- `stateHash()` — 规范化快照的 SHA-256。

## CLI

```
explree tree.json actors.json
```

枚举保留各参与者顺序的所有交错（按参与者 id 字典序），逐步执行并在每步后校验不变量：

- 全部安全 → 输出安全证书（交错数、执行步数、终态哈希集合、`certificateHash`），退出码 0。
- 发现违例 → 输出字典序最小反例：操作轨迹、祖先占用链（`ancestorChain`）、状态哈希（`stateHash`）与完整快照，退出码 1。
- 输入非法（环、未知节点、坏 actors 等）→ `INVALID_TREE`/`INVALID_BATCH`，退出码 2。

`actors.json` 形如 `{ "actors": [{ "id": "A", "ops": [{ "op": "reserve", "batch": "b1", "holds": [{ "node": "a", "amount": 10 }] }, { "op": "settle", "batch": "b1" }] }] }`，支持的 op：`reserve`/`cancel`/`release`/`settle`/`freeze`/`unfreeze`。被拒绝的操作（如超额）记为正常拒绝而非违例。

## 测试

```
node --test
```

- 验收 1–3：`test/budget.test.js`（兄弟批次互不影响、深层超额整批回滚祖先归零、环/重复批次/未知节点拒绝码）。
- 验收 4：`test/enumerator.test.js` 用独立的多重集排列枚举器（next-permutation）与独立的重放模型，对深度 2、≤4 步的 6 组参与者逐序列对照枚举结果、每步接受/拒绝与终态。
