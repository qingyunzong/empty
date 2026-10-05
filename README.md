# sliding-window-order-stats

固定大小滑窗整数统计库：持久化序统计索引、事件 ID 更正、有理数分位查询、
分支合并与冲突秩界。TypeScript + Node.js 内置库（`node:test` / `node:assert`），
无第三方运行时依赖。

## 语义

- **滑窗**：容量固定；`addEvent` 超出容量时逐出最旧事件并删除其值；重复整数按
  多重集维护；`correctEvent(id, v)` 原地更正存活事件的值（不改变其滑窗顺序），
  更正已逐出/未知 id 抛错。
- **分位**：`quantile(p)` 取排序后第 `ceil(p*n)` 秩（1 起始）；`p` 为有理数
  `rational(num, den)`，内部用 bigint 精确计算；`p = 0` 取最小值；空窗返回
  `null`。
- **持久索引**：`src/order-stats-tree.ts` 为路径复制的持久 treap（优先级由键的
  确定性散列导出），节点存 `count`（重复计数）与 `size`（子树总数），支持
  O(log n) 的 `rankOf` / `kth`。所有更新返回新根，旧根永远可读。
- **分支与合并**：`StatsStore.fork` 从任一分支派生仅可更正的分支；
  `merge` 要求两侧共享同一 fork 点。双侧对同一事件的不同更正形成冲突，
  其余更正确定地并入。
- **未解决冲突**：`MergedView.rankOfBounds(x)` 返回 `{ certain, low, high }`
  （确定部分 + 不确定秩的紧界）；`quantileBounds(p)` 返回分位值的紧界
  （秩 `ceil(p*n)` 与解决方式无关，k 阶统计量对每个元素单调，故极值在全部
  冲突取小/取大侧时达到）。`enumerateResolutions()` 独立枚举全部 2^k 种解决。
- **原子发布**：`resolveConflict` 计算出新不可变状态后单次引用换出并递增
  `version`；发布前取得的快照（含未解决的 `MergedView`）永久可读。

## 结构

- `src/order-stats-tree.ts` — 持久序统计树（多重集 treap）
- `src/rational.ts` — 有理数与 `ceil(p*n)` 秩计算
- `src/window.ts` — 不可变滑窗状态与纯函数操作
- `src/branch.ts` — 分支、合并、`MergedView` 冲突秩界、原子发布
- `test/` — 模型核对（每步排序数组预言机）、持久化快照、合并冲突测试
- `types/node-shims.d.ts` — 环境无 @types/node，为 `node:test`/`node:assert` 提供最小声明

## 运行

```sh
npm test   # tsc 编译后用 node --test 运行全部测试
```

实际测试结果见 `RESULTS.md`。
