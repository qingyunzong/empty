# det-rewrite

确定性字符串重写库。TypeScript 编写，仅依赖 Node.js 内置模块（`node:test` / `node:assert`），零第三方依赖。

## 功能

- **确定性选步**：每步按 ① 最左匹配位置 → ② 最长左式 → ③ 规则 ID（码元序）选择唯一一步，与规则书写顺序无关。
- **长度可变规则**：右式可长于或短于左式（含空右式删除规则）。
- **逆差分与原文来源**：每步记录 `position` / `removed` / `inserted`（逆差分）及 `before` / `after` 完整来源状态；`undo(trace)` 可逆向还原原文，`stateAt(trace, i)` 可重放任意中间状态。
- **循环检测**：对完整状态做哈希记录，状态重复时给出循环证据 `CycleEvidence`（重复状态、首次出现步、重复步、周期长度、构成循环的步骤序列）。
- **预算耗尽核对**：超过 `maxSteps` 未闭合时，自动用独立的短串解释器（`src/interpreter.ts`，按位置扫描的不同实现）逐步比对全部状态，输出 `Verification`；状态超过 `verifyMaxLength` 时跳过核对并说明原因。

## 结果类型

```ts
type Outcome =
  | { kind: 'normal-form'; steps: number }                       // 闭合（无规则可应用）
  | { kind: 'cycle'; evidence: CycleEvidence }                   // 检测到完整状态重复
  | { kind: 'budget-exhausted'; steps: number; verification: Verification };
```

## 用法

```ts
import { rewrite, undo } from './src/index.js';

const trace = rewrite(
  [
    { id: 'grow', lhs: 'ab', rhs: 'bba' },
    { id: 'shrink', lhs: 'bb', rhs: 'b' },
  ],
  'ab',
  { maxSteps: 1000 },
);
// trace.final === 'ba', trace.outcome.kind === 'normal-form'
// undo(trace) === 'ab'
```

## 构建与测试

需要全局可用的 `tsc`（本环境为 TypeScript 7.0.2）与 Node.js（本环境为 v22.22.1）。

```sh
npm test   # tsc -p tsconfig.json && node --test "dist/test/*.test.js"
```

## 实际测试结果（2026-10-05，Node v22.22.1）

`npm test` 退出码 0：

```
✔ dist/test/rewrite.test.js (207.725469ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 223.480751
```

展开文件内明细（`node dist/test/rewrite.test.js`）：7 个套件、19 个断言全部通过：

```
# tests 19
# suites 7
# pass 19
# fail 0
```

覆盖：最左/最长左式/规则 ID 选步（4）、长度增减与删除规则（2）、逆差分还原与来源链（3）、循环证据（含瞬态后进入循环）（2）、预算耗尽解释器核对 / 篡改检测 / 超长跳过（3）、解释器独立行为（2）、规则校验与确定性（3）。

## 文件结构

- `src/rewrite.ts` — 选步、重写主循环、逆差分还原、循环证据、核对
- `src/interpreter.ts` — 独立短串解释器（交叉核对用）
- `src/index.ts` — 导出入口
- `test/rewrite.test.ts` — `node:test` 测试
- `types/node.d.ts` — `node:test` / `node:assert` 最小类型声明（避免外部 @types 依赖）
