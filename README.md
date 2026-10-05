# collab-tree-merge

协作树三方合并库：以节点 ID 标识节点，按操作优先级合并两侧的父指针变动；
双侧各自合法的移动组合后可能成环，按规则取消环中最低优先边并附证据；
删除以墓碑形式保留子树。纯 TypeScript，运行时零依赖（仅 Node.js 内置模块）。

## 模型

- `TreeState`：`parent: Map<NodeId, NodeId | null>` + `tombstone: Set<NodeId>`。
- 操作：`move(id, newParent)` / `delete(id)`；每侧操作按下标获得侧内序号 `seq`。
- 操作优先级：`(seq, side)` 字典序，`seq` 大者优先；同序号跨侧时 `right` 优先于 `left`（决胜规则）。

## 合并算法（`src/merge.ts`）

1. **逐节点裁决**：同一节点两侧都移动时，优先级高的一侧胜出，记录 `conflicts`。
2. **墓碑并集**：两侧 `delete` 取并集；墓碑节点及其子树保留在树中，仍参与合并与解环。
3. **应用父指针**：基底父指针被获胜操作覆盖，每条边记录来源（`base` 或产生它的操作优先级）。
4. **解环**：父指针是函数图（每点出度 ≤1），三色标记找环；每轮取消环中
   **优先级最低的边**（操作优先级优先，节点 ID 决胜）：
   - 操作产生的边 → 回退到该节点的基底父指针；
   - 基底边（回退无效）→ 断开为 `null`。
   每轮在 `evidence` 中记录：轮次、环上节点、被取消边、边的来源、回退结果与原因。
   基底图无环 ⇒ 每个环至少含一条操作边，每轮严格减少非常规边，必然终止。

## 测试

```sh
npm test   # tsc 编译后运行 node --test（需全局 tsc；运行时零依赖）
```

- `test/merge.test.ts`：单元测试（冲突裁决、组合环解环与证据、基底边 ID 决胜、
  墓碑子树保留、确定性）。
- `test/enumerate.test.ts`：枚举核对——
  - n=4 全部 16 棵有根标号树 × 双侧合法移动序列（长度 ≤2）：**103,596 次合并，
    解除 6,438 个组合环，结果全部无环**，且每次合并重算结果一致（确定性）；
  - n=3 含删除操作：**3,622 次合并，2,416 个墓碑用例**，墓碑子树全部保留、无环。

## 实际测试记录（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
$ npm test
# Subtest: dist/test/enumerate.test.js
ok 1 - dist/test/enumerate.test.js   (n=4: 103596 merges, 6438 cycle(s) broken, all acyclic)
                                     (n=3 with deletes: 3622 merges, 2416 tombstone case(s))
# Subtest: dist/test/merge.test.js
ok 2 - dist/test/merge.test.js
# tests 2
# pass 2
# fail 0
```
