# relation-store

TypeScript 实现的有向带标签多重图关系库，仅依赖 Node.js 内置模块
（`node:test` / `node:assert`），无任何 npm 依赖。

## 语义

- **有向带标签边**：边为 `{ id, from, to, label }`，按边 ID 索引。
- **同端点多 ID 不合并**：同一对端点之间可共存多条边，ID 不同即为不同边，
  差分与删除均按 ID 精确匹配。
- **循环允许**：自环（`from === to`）与任意环均合法。
- **批次原子**：`store.commit(ops)` 先在工作副本上逐条校验全部操作，
  任一操作非法（重复 ID、删除/改标不存在的边等）则整批拒绝，
  库保持原版本对象不变。
- **版本差**：`diff(a, b)` 输出 `added` / `removed` / `relabeled` 三类；
  ID 同存但端点变化计为「删除 + 新增」，仅标签变化计为标签修改。
- **逆差验证**：`invert(diff(a, b))` 应用于当前版本 `b` 必须精确还原
  前像 `a`（`verifyReverse` / `applyDiff` 提供，`applyDiff` 对过期差分
  做内容校验并拒绝）。

## 结构

- `src/store.ts` — 核心库：`Version`（不可变快照）、`RelationStore`
  （原子批次提交）、`diff` / `invert` / `applyDiff` / `verifyReverse`。
- `src/store.test.ts` — 单元测试（`node:test`）。
- `src/property.test.ts` — 随机化属性测试：确定性 PRNG（mulberry32）
  生成随机版本链，将库差分与「ID → (from, to, label) 集合差」参考模型
  逐对对照，并验证正向应用到达目标、逆差还原前像；另以随机腐化批次
  验证原子性。
- `src/node-shims.d.ts` — `node:test` / `node:assert` 的最小类型声明，
  避免引入 `@types/node`。

## 运行

```sh
npm test    # tsc 编译到 dist/ 后用 node --test 运行
```

前提：Node.js（开发环境为 v22.22.1）与 `tsc`（开发环境为 7.0.2）在 PATH 中。

## 实际测试结果（2026-10-05 记录）

`npm test` 退出码 0，输出摘要：

```
# tests 2
# pass 2
# fail 0
```

两个测试文件（`dist/store.test.js`、`dist/property.test.js`）全部通过。
逐条展开：

```
ok 1 - batch commit adds, removes and relabels edges
ok 2 - cycles and self-loops are allowed
ok 3 - same endpoints with different ids are not merged
ok 4 - batches are atomic: a failing op discards the whole batch
ok 5 - diff reports added, removed and relabeled edges
ok 6 - reverse diff restores the previous version exactly
ok 7 - applyDiff validates content and rejects stale diffs
ok 8 - versions are immutable snapshots
ok 9 - property: store diff matches the set-difference reference model on random versions
ok 10 - property: atomicity holds for randomly corrupted batches
# tests 10
# pass 10
# fail 0
```

属性测试日志：

```
property test: 750 random version pairs cross-checked (25 seeds)
property test: 244 corrupted batches rejected atomically
```
