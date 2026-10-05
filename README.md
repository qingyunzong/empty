# bigint-budget-eval

TypeScript 编写的任意精度整数表达式求值库，仅依赖 Node.js 内置模块
（`BigInt`、`node:test`、`node:assert`）。除求值步数外，还限制任何中间
（及最终）整数值的位数，并在超限时抛出携带子式源码范围的 `BudgetError`。

## 表达式语言

- 十进制整数字面量（任意精度）
- 运算符：`+ - * **`、比较 `< <= > >= == !=`（结果为 `0`/`1`）
- 短路运算符：`&&` `||` 与三元 `cond ? a : b`
- 括号与一元负号；`**` 右结合且优先于一元负号（`-2 ** 2 === -4`）

## 预算语义

`evaluate(source, { maxSteps, maxBits })`：

- **步数预算**：每求值一个 AST 节点消耗 1 步，耗尽时抛出
  `BudgetError { kind: "steps" }`。
- **位预算**：每个中间结果的位长（`bitLength`，按绝对值计，`0` 为 0 位）
  不得超过 `maxBits`，超限抛出 `BudgetError { kind: "bits" }`。
- **乘法先估计再执行**：计算 `a * b` 前先用上界
  `bitlen(a) + bitlen(b)` 估计，估计已超限则直接拒绝，不执行乘法；
  通过后再对精确结果复核。
- **乘幂先估计再执行**：`b ** e`（`e ≥ 0`）用上界 `bitlen(b) * e` 估计，
  因此 `7 ** 123456789012345678901234567890` 这类极大指数在不实际
  计算的情况下被确定性地拒绝——拒绝结果只取决于输入，可复现。
- **错误携带子式范围**：`BudgetError.span` 是超限子式在源码中的
  `[start, end)` 偏移，`err.expr` 给出对应源码片段；位预算错误还带有
  `needed`（所需位数）与 `estimated`（是否为执行前估计值）。
- **短路不耗预算**：`&&`、`||`、`?:` 未被选中的分支完全不求值，
  既不耗步数也不耗位预算。

## API

```ts
import { evaluate, BudgetError } from "./src/index.js";

evaluate("2 ** 256 + 1", { maxSteps: 100, maxBits: 4096 }); // 精确 BigInt
try {
  evaluate("(2 ** 10) * (2 ** 10)", { maxSteps: 100, maxBits: 21 });
} catch (err) {
  // BudgetError: kind="bits", limit=21, needed=22n, estimated=true,
  // span 覆盖整个 "(2 ** 10) * (2 ** 10)"
}
```

## 测试

```
npm test    # tsc 编译后运行 node --test
```

测试包含一个与库解析器相互独立的精确预言机：随机表达式生成器（固定
种子 `mulberry32(20261006)`，可复现）在生成源码的同时用原生 `BigInt`
算出期望值，500 个随机小式逐一与库求值结果对照。

## 实际测试结果（2026-10-06，Node v22.22.1）

```
ok 1 - basic arithmetic and precedence
ok 2 - arbitrary precision results are exact
ok 3 - comparisons and conditionals
ok 4 - randomized small expressions match exact oracle
ok 5 - step budget exceeded reports the failing subexpression range
ok 6 - oversized literal is rejected with its source range
ok 7 - multiplication is estimated before execution and error carries the '*' range
ok 8 - addition result bits are checked exactly
ok 9 - astronomical exponents are rejected reproducibly
ok 10 - nested huge power is rejected at the inner subexpression
ok 11 - negative exponent is a deterministic evaluation error
ok 12 - short-circuited branches consume no bit budget
ok 13 - short-circuited branches consume no step budget
ok 14 - syntax errors carry a source range
ok 15 - bitLength
# tests 15
# pass 15
# fail 0
```

## 文件结构

- `src/lexer.ts` — 词法分析
- `src/parser.ts` — 递归下降解析，AST 节点带源码范围（含括号）
- `src/eval.ts` — 带步数/位预算的求值器，乘法与乘幂先估计再执行
- `src/errors.ts` — `CalcError` / `BudgetError` / `SyntaxError_`
- `test/eval.test.ts` — 15 个测试（含 500 式随机对照）
- `test/node-shims.d.ts` — 环境无法安装 `@types/node`，为用到的
  `node:test` / `node:assert` 接口提供最小声明
