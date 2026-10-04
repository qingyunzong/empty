# collab-tree-merge

协作树三方合并库：按节点 ID 合并两侧的父节点变动；双侧各自合法的移动组合成环时，
按 (操作优先级, 操作 ID) 取消环中最低优先边并附完整证据；墓碑子树保留不丢弃。
纯 TypeScript，仅使用 Node.js 内置模块（`node:test` / `node:assert`），零运行时依赖。

## 模型

- `Tree`：根 + `parent: Map<NodeId, NodeId | null>`，根是唯一父为 null 的节点。
- 操作日志（每侧相对共同基树有序回放）：
  - `move { opId, priority, nodeId, newParentId }` — 单节点换父；
  - `delete { opId, priority, nodeId }` — 墓碑化子树根，子树整体保留在树中。
- 每侧先独立校验：移动根、移入自身子树、未知节点、删除根等非法操作被拒绝并记录原因
  （`MergeResult.rejected`），不参与合并。

## 合并规则

1. **按节点 ID 取父**：右侧改过 → 用右侧最终父；否则左侧改过 → 用左侧；否则用基树父。
   双侧改同一节点记为 `conflicts`（右侧胜）。
2. **墓碑**：每侧删除操作的子树（按该侧最终树计算）标记为墓碑，合并取两侧并集；
   墓碑节点及其边全部保留在结果树中，绝不丢弃。
3. **破环**：双侧合法移动可能组合成环（环中甚至可含未变动的基树边）。循环执行：
   找环 → 候选边按 `(priority, opId)` 升序取最低者取消（基树边优先级视为 ∞，
   纯基树边环不存在，故每个环必有可取消的操作边）→ 该节点回退到
   「另一侧的值（若另一侧也改过）→ 基树父」链中的下一选择。
   每次取消严格消耗一条操作边，保证终止。
4. **证据**：每次破环记录 `CycleBreakEvidence`：环上节点序列、被取消边
   （节点、原父、opId、priority、所属侧）、回退目标（来源侧/base）、
   环上全部候选边及其出处、人类可读的 `reason`。

## 布局

- `src/tree.ts` — 树模型、子树/祖先查询、`findCycle` 环检测
- `src/merge.ts` — 操作应用与校验、三方合并、破环与证据
- `tests/merge.test.ts` — 11 个单元测试（环、优先级平局、基树边保护、
  冲突回退、墓碑保留/并集、非法操作、确定性）
- `tests/enumerate.test.ts` — 小树穷举核对
- `types/node-shim.d.ts` — 离线环境的最小 Node 内置模块类型声明

## 测试

```sh
npm test     # tsc 编译到 dist/ 后用 node --test 运行
npm run check  # 仅类型检查
```

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
$ npm test
ok 1 - dist/tests/enumerate.test.js
ok 2 - dist/tests/merge.test.js
# tests 2
# pass 2
# fail 0
# duration_ms ~1450
```

枚举核对规模（`tests/enumerate.test.ts` 实测输出）：

```
enumeration totals: merges=44526 cyclesBroken=5718 mergesWithTombstones=198
# tests 4   # pass 4   # fail 0      (merge.test.js: # tests 11 # pass 11 # fail 0)
```

穷举覆盖：全部 125 棵 4 节点基树 × 每侧全部合法单移动 × 3 种优先级序；
全部 16 棵 3 节点基树 × 每侧长度 ≤2 的合法移动序列；删除 × 并发移动组合。
对每次合并断言：结果无环、节点集完整、全树可达根、破环证据中被取消边确为
候选最小者、回退值与来源一致、墓碑节点全部保留。
