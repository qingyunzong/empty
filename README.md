# peg-cut

PEG 语法库（TypeScript，仅依赖 Node.js 内置模块，零运行时依赖），支持
**序列、优先选择、重复、显式 cut**，提供可开关的**记忆化（packrat）解释器**
与**无缓存解释器**对照，并输出**最远失败集合**。

## 算子

| 算子 | 说明 |
| --- | --- |
| `lit("a")` / `re(/\d+/, "number")` / `eof` / `eps` | 终结符 |
| `seq(p, q, ...)` | 序列 |
| `alt(p, q, ...)` | 优先选择：按序尝试，第一个成功分支生效 |
| `rep(p, min?)` | 重复（默认 0 次起）；`opt(p)` 为可选 |
| `cut` | 显式 cut：零消费恒成功，提交其后失败 |
| `lazy(() => p)` | 递归规则 |

`parse(parser, input, { memo })` 返回
`{ ok, pos, committed, failure: { pos, expected[] }, evals }`。

## 语义约定

- **cut**：同一 `seq` 中位于其后的失败变为“已提交失败”。
  - 已提交失败穿透 `alt` / `rep` / 外层 `seq` 直到顶层，任何选择算子
    都不得再尝试后备分支。
  - **cut 作用域**为最近的封闭选择点（`alt` / `rep`）：分支成功时该
    选择点消费掉 cut 标志，cut 不会经成功的分支泄漏到外层。这正是
    `term = alt(seq("(", cut, expr, ")"), num)` 这类语法能正确工作的
    关键——括号组匹配成功后，内层 cut 不影响外层后续兄弟的回溯。
- **重复零消费**：`rep` 循环体成功但未消费输入属于语法错误，抛出
  `GrammarError`（如 `rep(opt(lit("a")))`、`rep(re(/a*/))`）。
- **最远失败集合**：所有终结符失败都记录到全局跟踪器；出现更远失败时
  重置集合，同一最远位置汇集全部期望终结符。成功解析同样保留该信息。

## 记忆化为什么不混淆 cut 作用域

`Result`（成功/失败）内部携带 cut 标志，任何子解析的结果只取决于
`(parser, pos)`，不依赖外部可变的 cut 状态；因此按 `(parser, pos)`
缓存是安全的，cut 作用域无需也不会进入缓存键。缓存命中只是回放
完全相同的 `Result`（含 cut 标志），两种解释器语义一致。

最远失败集合也不受缓存影响：同一 `(parser, pos)` 的重复求值记录的
失败完全相同，缓存命中跳过重复记录不改变最终集合。

测试通过 400 组随机语法 × 随机输入对两种解释器做深度对照
（`ok` / `pos` / `committed` / 最远失败集合完全一致，且记忆化求值
次数不多于无缓存）。

## 运行

```sh
npm test   # tsc && node --test "dist/test/*.test.js"
```

需要全局可用的 `tsc`（本仓库无 npm 依赖，无需 `npm install`）。

## 实际测试结果

在 Node.js v22.22.1、TypeScript 7.0.2 下执行 `npm test`，实际输出：

```
    ok 1 - 字面量序列匹配与失败位置
    ok 2 - 正则终结符
ok 1 - 序列与终结符
    ok 1 - 分支按优先级顺序生效
    ok 2 - 普通失败会回退到后备分支
ok 2 - 优先选择
    ok 1 - 零次或多次
    ok 2 - 最小次数约束
    ok 3 - 循环体零消费报语法错误（两种解释器一致）
ok 3 - 重复
    ok 1 - cut 后失败不尝试后备分支
    ok 2 - cut 前的失败仍可回溯
    ok 3 - 已提交失败穿透 rep 与外层选择直到顶层
ok 4 - 显式 cut
    ok 1 - 缓存命中不被先前 cut 上下文污染
    ok 2 - cut 标志随缓存结果一起保存与回放
    ok 3 - 记忆化确实减少重复求值
ok 5 - 记忆化与 cut 作用域
    ok 1 - 内层 cut 不污染外层后续兄弟的软失败
ok 6 - cut 作用域在分支成功处封闭
    ok 1 - 汇集同一最远位置的全部期望
    ok 2 - 更远失败会重置集合
    ok 3 - 成功时也保留最远失败信息
ok 7 - 最远失败集合
    ok 1 - 合法输入
    ok 2 - 缺右括号：已提交失败并指向最远位置
ok 8 - 表达式语法（cut 用于报错）
    ok 1 - 400 组随机语法×输入结果完全一致
ok 9 - 记忆化解释器 vs 无缓存解释器（随机对照）
# tests 20
# suites 9
# pass 20
# fail 0
```

20/20 通过。

## 示例

```ts
import { alt, cut, eof, lazy, lit, parse, re, seq } from "./src/peg.js";

const num = re(/\d+/, "number");
const expr = lazy(() => alt(seq(term, lit("+"), cut, expr), term));
const term = lazy(() => alt(seq(lit("("), cut, expr, lit(")")), num));

parse(seq(expr, eof), "1+2+(3+4)");
// { ok: true, pos: 9, committed: false, failure: {...}, evals: ... }

parse(seq(expr, eof), "1+(2");
// { ok: false, committed: true,
//   failure: { pos: 4, expected: ['"+"', '")"'] }, ... }
```
