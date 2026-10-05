# bigint-budget-eval

带资源预算的任意精度整数表达式求值库。TypeScript 编写，运行时只使用
Node.js 内置模块（`node:test` / `node:assert`，值用 `BigInt`），零第三方依赖。

## 功能

- **任意精度整数运算**：`+`、`-`（二元/一元）、`*`、`^`（幂，右结合）、
  比较（`== != < <= > >=`，结果为 0/1）、短路逻辑（`&& ||`）、
  条件表达式（`cond ? a : b`）、括号与十进制整数字面量。
- **双重预算**：
  - `maxSteps`：求值步数上限（每求值一个 AST 节点计 1 步）；
  - `maxDigits`：中间结果十进制位数总预算。每个被求值的字面量和每个
    运算符产出的中间值，都按其实际十进制位数从预算中扣除。
- **乘法先估计再执行**：`|a| < 10^da、|b| < 10^db ⇒ |a*b| < 10^(da+db)`，
  因此在执行乘法前先按 `da + db` 上界检查预算，超出则直接抛错，
  不做乘法；通过检查后再按结果的真实位数扣预算。
- **幂次先估计再执行**：`|b| < 10^d ⇒ |b|^e < 10^(d*e)`，按 `d * e`
  （BigInt 运算，不会溢出）上界检查。`2 ^ 1000000000`、`10 ^ (10 ^ 9)`
  这类极大指数在**不计算任何大数**的情况下被确定性拒绝，多次运行
  产生完全相同的错误。`|base| ≤ 1` 与 `e = 0` 走 O(1) 特判（`0^0 := 1`）。
- **预算错误带子式范围**：`BudgetError` 携带 `budgetKind`
  （`'step' | 'digit'`）、触发超支的子表达式源码范围 `range: {start, end}`，
  以及 `needed` / `remaining` 明细。
- **短路分支不耗预算**：`&&`、`||`、`?:` 只求值实际走过的分支；
  未求值分支里的字面量和运算不消耗任何步数或位数预算。
- **精确解释器对照**：`src/interpreter.ts` 是同一语义无预算的独立实现，
  差分测试用固定种子的 PRNG 生成 2000 个随机小表达式，逐一比对
  预算求值器与精确解释器的结果。

## 语义约定

- 条件真值：非 0 为真；`&&`/`||`/比较运算返回 `0` 或 `1`。
- 负指数抛 `EvalError`（整数运算不产生分数）。
- 求值顺序从左到右。

## API

```ts
import { evaluate, evaluateExact, parse, BudgetError, EvalError, ParseError } from './src/index.ts';

evaluate('2 + 3 * 4');                       // { value: 14n, stepsUsed, digitsUsed }
evaluate('2 ^ 1000000000');                  // 抛 BudgetError { budgetKind: 'digit', range, needed }
evaluate('1 || 2 ^ 1000000000').value;       // 1n —— 右操作数从未求值
evaluate('999 * 999', { maxSteps: 100, maxDigits: 1000 });
evaluateExact('2 + 3 * 4');                  // 14n —— 无预算参照实现
```

默认预算：`maxSteps = 100_000`，`maxDigits = 10_000`。

## 目录结构

- `src/ast.ts` —— AST 定义，每个节点带源码范围 `range`
- `src/parser.ts` —— 词法分析 + 递归下降语法分析
- `src/evaluator.ts` —— 带预算求值器（步数/位数、乘法与幂次预估、短路）
- `src/interpreter.ts` —— 无预算精确解释器（差分对照用）
- `src/errors.ts` —— `ParseError` / `EvalError` / `BudgetError`
- `test/` —— `node:test` 测试（解析、求值、预算、差分对照）

## 运行

```sh
npm test          # tsc 编译到 dist/ 后用 node --test 跑全部测试
npm run typecheck # tsc --noEmit
```

要求：Node.js（开发环境为 v22.22.1）与 TypeScript 编译器（开发环境为
tsc 7.0.2）。本仓库的 Node 构建未启用 `--experimental-strip-types`，
因此测试前先编译为 JS；运行时无任何第三方依赖。

## 测试结果

实际运行结果记录在 `test-results.txt`：4 个测试文件共 48 个用例全部通过，
其中差分测试以种子 `0x5eed` 生成 2000 个随机表达式，与精确解释器
比对 2000/2000 一致、0 处不符。
