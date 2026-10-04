# unit-calc

带单位的表达式计算库（TypeScript + Node.js 内置库，零运行时依赖）。

## 特性

- **精确有理数**：所有数值用 BigInt 分子/分母表示并自动约分，`0.1 + 0.2` 精确等于 `3/10`。
- **整数维度向量**：7 个 SI 基本维（L M T I Θ N J）上的整数指数向量；乘除合并维度，幂运算按比例缩放。
- **加减同维检查**：维度必须一致，**零不豁免**——`0 m + 0 s` 同样报错。
- **结构化错误**：错误携带出错子表达式的字符区间 `[start, end)` 及两侧的规范单位（如 `kg·m^2/s^2`）。
- **小语法树交叉核对**：AST 序列化为最小 JSON 树（`STree`），由独立的第二求值器重新求值，两者结果必须完全一致才返回成功。

## 用法

```bash
npm test   # tsc 编译 + node --test
```

```ts
import { evaluate } from "./src/index";

evaluate("3 N * 2 m");
// { ok: true, value: 6n/1n, unit: "kg·m^2/s^2", display: "6 kg·m^2/s^2",
//   tree: ["bin","*",...], sexpr: "(* (* 3 N) (* 2 m))", crossChecked: true }

evaluate("1 m + 1 s");
// { ok: false, error: { message: "cannot add 's' to 'm'",
//   start: 0, end: 9, leftUnit: "m", rightUnit: "s",
//   leftRange: { start: 0, end: 3 }, rightRange: { start: 6, end: 9 } } }
```

## 语法

```
expr    := term (('+' | '-') term)*
term    := juxt (('*' | '/') juxt)*
juxt    := factor (implicit factor)*   // 并置（隐式乘法）优先级高于 * 和 /
factor  := unary ('^' unary)?
unary   := '-' unary | primary
primary := num | unit | '(' expr ')'
```

- 数字：整数、小数、科学计数法（`12`、`3.14`、`1e-3`），均精确解析为有理数。
- 隐式乘法：`3 km`、`2 (3 + 4)`、`10 m / 4 s`（= `5/2 m/s`）。
- 幂：指数必须是无量纲整数，如 `m^2`、`s^-1`、`(2 m)^2`。
- 内置单位：SI 基本单位（`m kg s A K mol cd`）、常用词头（`km cm mm um nm g mg t ms min h d`）、`L mL` 及导出单位（`Hz N Pa J W C V`）。

## 结果表示

- 数值一律化约为 SI 基本单位下的精确有理数（`2 km + 300 m` → `2300 m`）。
- 规范单位按 `kg·m·s·A·K·mol·cd` 顺序输出，负指数放分母：`kg·m^2/s^2`、`1/s`；无量纲为 `1`。

## 模块结构

- `src/rational.ts` — BigInt 精确有理数
- `src/dims.ts` — 整数维度向量与规范单位格式化
- `src/units.ts` — 单位表（精确换算因子）
- `src/lexer.ts` / `src/parser.ts` / `src/ast.ts` — 词法、递归下降语法分析（节点带区间）
- `src/eval.ts` — 主求值器（量纲检查、`UnitError` 带区间与规范单位）
- `src/tree.ts` — 小语法树序列化 + 独立复核求值器
- `src/index.ts` — 公共 API `evaluate(src)`，执行交叉核对

## 实际测试结果

见下方"Test results"（`npm test` 真实输出，2026-10-05，Node v22.22.1，tsc 7.0.2）：

```
# tests 22
# suites 5
# pass 22
# fail 0
```
