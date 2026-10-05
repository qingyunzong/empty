# leftmost-rewriter

确定性字符串重写库。TypeScript 编写，仅使用 Node.js 内置模块（`node:test` /
`node:assert`），零运行时依赖。

## 语义

每一步按以下顺序选择唯一一个匹配（`selectMatch`，src/rewrite.ts:78）：

1. **最左位置**：每条规则取左式在当前串中的首次出现位置，位置最小者优先；
2. **最长左式**：位置相同，左式更长者优先；
3. **规则 ID**：仍并列，ID 较小者优先。

规则的右式可以比左式长或短（长度可增可减）。左式为空的规则会被
`validateRules` 拒绝（否则必然死循环）。

## 记录与证据

- **逆差分**（`InverseDelta`）：每步记录 `{ step, ruleId, position, removed,
  inserted }`，`undoAll` 可逆放全部差分、从末态重建原文；差分与当前串不符时抛错。
- **原文来源**（`provenance`）：与当前串等长的 token 序列，每个字符标注
  `{ kind: 'original', index }`（来自原文第几个字符）或
  `{ kind: 'produced', ruleId, step }`（由哪条规则在第几步生成）。
- **循环证据**：用 `Map<完整状态串, 步号>` 检测完整状态重复。命中时状态为
  `{ kind: 'cycle', cycleStart, cycleLength }`，`cycleEvidence` 给出从
  `cycleStart` 到重复发生的全部步记录，重放这些步可回到同一状态。

## 预算耗尽与核对

`run(rules, input, { budget })` 的终止状态有三种：`normal-form`（无规则可
用）、`cycle`（状态重复）、`budget-exhausted`（预算耗尽未闭合）。最后一种
情况自动触发核对（可用 `crossCheckOnBudgetExhaustion: false` 关闭）：

- **短串解释器核对**：`interpretTrajectory` 是同一选择语义的独立朴素实现
  （只操作字符串、按长度/ID 预排序），从原文重放相同步数，逐步比对轨迹，
  报告 `interpreterAgrees` 与首个分歧步 `firstDivergenceStep`；
- **逆差分校验**：逆放全部逆差分，确认精确重建原文
  （`undoRestoresOriginal`）。

## 使用

```ts
import { run } from './src/rewrite.js';

const result = run(
  [
    { id: 1, lhs: 'a', rhs: 'bb' },   // 增长
    { id: 2, lhs: 'bbb', rhs: 'c' },  // 缩短
  ],
  'aaaaa',
  { budget: 5 },
);
// result.status -> { kind: 'budget-exhausted', steps: 5 }
// result.final  -> 'ccaa'
// result.crossCheck -> { interpreterAgrees: true, firstDivergenceStep: null,
//                        undoRestoresOriginal: true }
```

## 测试

```
npm test        # tsc 编译到 dist/ 后用 node --test 运行
npm run typecheck
```

### 实际运行结果（2026-10-05 记录）

环境：Node.js v22.22.1，TypeScript 编译器 7.0.2，npm 9.2.0。

`npm test` 输出摘要（TAP）：

```
ok 1 - selection: leftmost position wins over longer LHS elsewhere
ok 2 - selection: longest LHS breaks a same-position tie
ok 3 - selection: smallest rule id breaks a same-position same-length tie
ok 4 - selection: returns null at normal form
ok 5 - rules may shrink and grow the string
ok 6 - inverse deltas undo every step back to the original input
ok 7 - undoAll rejects an inverse delta that does not apply
ok 8 - provenance tracks original indices and produced characters
ok 9 - provenance survives length-changing multi-step runs
ok 10 - full-state repetition yields cycle evidence
ok 11 - cycle detection works with an offset before the loop
ok 12 - normal form when no rule applies
ok 13 - budget exhaustion triggers interpreter cross-check
ok 14 - cross-check agrees on a mixed grow/shrink system
ok 15 - cross-check can be disabled
ok 16 - rule validation rejects empty LHS and duplicate ids
# tests 16
# pass 16
# fail 0
```

16 个测试全部通过（编译含 `strict` 模式类型检查，无错误）。

## 文件

- `src/rewrite.ts` — 引擎、选择函数、逆差分/来源/循环证据、朴素解释器与核对
- `test/rewrite.test.ts` — 16 个 `node:test` 测试
- `test/node-shims.d.ts` — `node:test` / `node:assert` 的最小类型声明
  （离线环境无法安装 `@types/node`）
