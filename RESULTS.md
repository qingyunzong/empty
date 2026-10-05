# 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2（`tsc`），npm 9.2.0。
命令：`npm test`（= `tsc -p tsconfig.json && node --test dist/test/*.test.js`）。
记录时间：2026-10-05T14:38:42Z（UTC）。结果：**全部通过，17/17**。

```
# tests 3   （测试文件：merge / persistence / window）
# pass 3
# fail 0
```

各文件子测试（均为 ok）：

**test/window.test.js**（6/6）
- ok 1 - quantileRank: ceil(p*n), p=0 selects the minimum
- ok 2 - empty window returns empty (null) for quantiles
- ok 3 - basic add, eviction deletes oldest, duplicates kept
- ok 4 - correction updates value in place; evicted ids are rejected
- ok 5 - model-based: per-step sorted-array oracle, extreme quantiles, duplicates
  （容量 7、3000 步随机 add/correct，每步与排序数组模型核对全部内容、
  p=0/p=1 极端分位、随机有理数分位、rankOf 与重复计数）
- ok 6 - model-based with corrections-heavy workload and capacity 1

**test/persistence.test.js**（2/2）
- ok 1 - persistent index: every historical snapshot stays fully readable
  （11 个历史快照在后续全部更新后重新核对内容/分位/秩）
- ok 2 - persistent tree roots are never mutated by later updates

**test/merge.test.js**（9/9）
- ok 1 - merge: one-sided and agreed corrections are certain; divergent ones conflict
- ok 2 - unresolved merge: rank bounds verified by independently enumerating both choices
  （16 个探测值 × 2 种解决枚举：每个秩界均被某一侧达到，即界为紧界）
- ok 3 - two conflicts: every rank bound checked against all four enumerated resolutions
- ok 4 - conflict resolution is an atomic publish; old snapshots stay readable
  （version 恰好 +1；解决前的 MergedView 快照核对秩界不变）
- ok 5 - stepwise resolution of multiple conflicts publishes intermediate views
- ok 6 - merge without conflicts publishes a resolved window directly
- ok 7 - merge rejects branches that added/evicted events since the fork
- ok 8 - mergeWindows guard: adds/evictions since the base are not mergeable
- ok 9 - merge requires a shared fork point and resolved inputs
