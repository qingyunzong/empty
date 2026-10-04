# expropt

一个整数表达式优化库（TypeScript + Node.js 内置库，无运行时依赖）。核心保证：
**优化前后程序的值、首个整数错误、副作用动作日志完全一致**，每次重写都记录前后源映射。

## 语言

```
expr := let x = expr in expr
      | if (expr, expr, expr)
      | log(expr)                      -- 副作用：把值追加到动作日志
      | expr (+|-|*|/|%) expr          -- int32 运算，溢出回绕
      | (expr) | <int> | <ident>
```

- 整数错误：`/`、`%` 除零报错；溢出按 int32 回绕（不报错）。
- 解释器严格从左到右求值，遇到首个错误即停，保留错误前已产生的日志。

## API

- `parse(src)` / `print(expr)`：源码 ↔ AST（节点携带 `span` 源区间）。
- `evaluate(expr)` → `{ value, error, log }`：值、首个错误、动作日志。
- `optimize(expr)` → `{ expr, rewrites }`：优化后 AST 与重写记录。
- `generate(rng, depth)` / `mulberry32(seed)`：确定性随机小树生成。

## 优化规则（均保持值 / 首个错误 / 日志顺序）

- **常量折叠**：纯常量子表达式求值；会产生除零错误的节点绝不折叠。
- **死分支消除**：`if` 条件为常量时只保留会执行的分支。
- **恒等式化简**：`x+0`、`x*1`、`x/1` 等；`x*0 → 0` 仅当被丢弃侧纯且不会报错。
- **公共子表达式共享（CSE）**：只共享**纯**（不含 `log`）且**必执行**
  （不在 `if` 分支内）的子表达式；提升点选在所有出现位置的最深公共祖先，
  且不越过绑定其自由变量的 `let`。若共享项可能报错，仅当它首次求值之前的
  所有代码都纯且不会报错时才提升（保证首个错误与日志前缀不变）。

每次重写记录 `{ rule, before, after, detail }`：`before` 是被替换节点的源区间，
`after` 是替换结果映射回的源区间（新节点继承来源节点的 span）。

## 测试

```sh
npm test    # tsc 编译 + node --test（仅 Node 内置模块）
```

实际运行结果（Node v22.22.1，tsc 7.0.2）：

```
# tests 3
# pass 3
# fail 0
```

- `test/interp.test.ts`：7 个用例 —— int32 回绕、截断除法、除零首错误与日志保留、if/let 语义。
- `test/optimize.test.ts`：12 个用例 —— 折叠保留除零错误、日志顺序、CSE 只共享纯且必执行项、
  不把可报错表达式提升过潜在错误、`x*0` 保留副作用、重写 span 均落在源码内。
- `test/differential.test.ts`：2000 棵随机小树（固定种子）比较优化前后的值、首个错误
  （含错误对应的源码片段）与动作日志，全部一致；其中 545 个程序触发整数错误、
  共记录 202 次 CSE 重写。

注：仓库内 `types/node-shims.d.ts` 是 `node:test` / `node:assert` 的最小类型声明，
用于在无法安装 `@types/node` 的离线环境下编译。
