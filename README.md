# expropt

整数表达式优化库（TypeScript，仅依赖 Node.js 内置模块）。优化过程保持整数错误
（除零 / 模零）与副作用日志（`log` 节点的动作序列）的先后顺序；公共子表达式
共享（CSE）只共享**纯且必执行**的子表达式；每次重写都记录前后源映射。

## 表达式语言

- `lit` 整数字面量（bigint，任意精度）
- `var` 变量（解释时由输入环境提供）
- `bin` 二元运算：`add / sub / mul / div / mod`（`div` 向零取整）
- `log` 副作用：求值子表达式，把值追加到动作日志并返回该值
- `if` 条件：cond ≠ 0 走 then，否则走 else（分支不是必执行）
- `err` 错误字面量（仅由常量折叠产生，在原位置抛出相同错误）
- `bind` / `ref` 共享绑定（仅由 CSE 产生）

整数错误：`div-by-zero`、`mod-by-zero`。解释结果为
`{ ok, value|error, log }` —— 值、首个错误、以及截至出错点的动作日志。

## 优化规则（`optimize`，见 src/optimize.ts）

- `fold-const`：纯常量子表达式折叠为字面量。
- `fold-error`：常量 `div/mod x 0` 折叠为 `err` 节点 —— 错误仍在原求值位置
  抛出，首个错误与日志顺序不变。
- `fold-if`：常量条件的 `if` 折叠为被取分支（未取分支本就不会执行）。
- `identity`：`x+0`、`x-0`、`x*1`、`x/1` 等，保留被保留操作数的副作用。
- `cse-bind` / `cse-ref`：仅当某个**纯**（不含 `log`）子表达式在**必执行**
  位置出现 ≥2 次时才共享：求值顺序上的第一次出现包成 `bind`（仍在原位置
  求值），其余替换为 `ref`。`if` 分支内、以及可能出错的左兄弟之后的
  位置都不算必执行，不参与共享。

每次重写产生一条 `RewriteRecord { rule, before: {id, src}, after: {id, src} }`，
并维护 `sourceMap`：被替换子树中每个原始节点 id → 替换后子树的节点 id 列表。

## 测试

```sh
npm test    # tsc 编译后用 node --test 运行
```

`test/optimize.test.ts` 包含定向单元测试（折叠保错、恒等式保副作用、CSE 只
共享纯且必执行项、重写映射完整性）和差分测试：用种子化随机生成器生成 3000
棵随机小树（深度 ≤ 4），逐一比较优化前后解释结果的值、首个错误与动作日志。

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
ok 1 - constant folding keeps value, first error and log order
ok 2 - identity rewrites keep side effects of the kept operand
ok 3 - cse shares pure always-executed duplicates via bind/ref
ok 4 - cse never shares conditional-branch, impure, or maybe-not-executed exprs
ok 5 - every rewrite records before/after source mapping
ok 6 - differential: random small trees preserve value, first error, action log
# tests 6
# pass 6
# fail 0
```

差分测试统计：3000 棵随机树全部一致；其中 366 棵触发整数错误、1264 棵产生
动作日志；各规则重写次数：fold-const 1956、fold-if 1343、identity 202、
fold-error 136、cse-bind 160、cse-ref 164。
