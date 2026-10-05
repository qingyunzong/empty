# sheet-engine

增量表格计算库（TypeScript + Node.js 内置库，零运行时依赖），并附带一个
朴素全表解释器作为差分测试的对照实现。

## 语义

- **单元格引用构成 DAG**：`setCell` 时按静态引用图（公式中出现的所有引用）
  做环检测，发现环则抛 `CycleError`，表格保持不变。运行时（动态）依赖图
  是静态图的子图，因此始终无环。
- **值为整数或错误**：`Value = int | error`。错误携带来源地址 `origin`：
  - `#DIV/0!`：来源为做除法的单元格；
  - `#EMPTY!`：来源为被引用的空单元格。
- **错误传播取最小来源地址**：多个错误相遇时，按行优先（先行后列）地址
  序取最小者传播（`src/value.ts` 的 `minError`）。注意是行主序而非字典序：
  `B1 < A9`。
- **动态条件只依赖选中分支**：`IF(cond, a, b)` 是惰性的，只对其条件与
  被选中分支求值，动态依赖只包含这两条路径上实际读到的引用；条件取反后
  依赖边即时重写，未选中分支里的错误不影响结果。
- **增量更新**：`setCell` 只重算受影响子图——变更单元格及其静态传递
  依赖者，按拓扑序各求值一次，并同步维护动态依赖边。

## 结构

- `src/address.ts` — 地址解析/格式化/行主序比较
- `src/value.ts` — 值与错误模型、最小来源地址传播
- `src/formula.ts` — 公式 AST 与递归下降解析器（`+ - * /`、比较、`IF`、括号）
- `src/eval.ts` — 共享求值器，返回实际读到的动态引用集
- `src/static-graph.ts` — 静态引用图与环检测
- `src/engine.ts` — 增量引擎（`Engine`）
- `src/interpreter.ts` — 朴素全表解释器（`Interpreter`，对照用 oracle）

## 测试

```
npm test   # tsc 编译后用 node:test 运行 dist/test/*.test.js
```

- `test/engine.test.ts` — 18 个单元测试：地址序、运算、错误来源与最小地址
  传播、IF 动态依赖切换、增量链/钻石更新、清空单元格、环拒绝。
- `test/differential.test.ts` — 差分模糊测试：确定性 PRNG（mulberry32）
  在 5 列 × 8 行的表格上随机设置/清除公式（含 IF、除零、空引用、比较），
  每个操作后比较增量引擎与全表解释器的整张表（值与错误来源逐一相等），
  并校验两边环检测结果一致。

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
$ npm test
# Subtest: dist/test/differential.test.js
ok 1 - dist/test/differential.test.js   (duration_ms ~1255)
# Subtest: dist/test/engine.test.js
ok 2 - dist/test/engine.test.js         (duration_ms ~237)
# tests 2   # pass 2   # fail 0
```

- 单元测试：18/18 通过。
- 差分模糊测试：30 个种子 × 400 个操作 = 12000 个随机操作，
  其中 9605 个写入被接受、2395 个因成环被双方一致拒绝、1821 个为清除操作；
  每步全表对照（含错误来源地址）均一致，0 处分歧。
