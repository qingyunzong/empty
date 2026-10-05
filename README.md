# rule-expr

规则表达式库（TypeScript + Node.js 内置库，无第三方依赖）。

## 语言

```
fn fact(n) { n <= 1 ? 1 : n * fact(n - 1) }   // 顶层函数声明（可多个，相互/递归可见）
fn adder(a) { fn (b) { a + b } }              // 词法作用域闭包
fact(20) + adder(1)(2)                        // 程序以一个表达式结尾
```

- 整数算术 `+ - * / %`（任意精度 BigInt；`/` 与 `%` 向零取整）
- 比较 `== != < <= > >=`，布尔 `&& || !`（`&&`/`||` 短路）
- 三目 `cond ? a : b`，只求值被选分支
- 除零只在实际求值时报错（解析、未选分支、未调用的函数体均不报错）
- 变量缺失抛出带源码范围（`span` 偏移 + 行列号）的 `EvalError`
- 函数参数惰性：实参包装为 thunk，首次读取时求值并缓存（值或错误）
- 闭包按引用捕获环境绑定（声明提升进同一帧，递归/前向引用/互递归可用）
- 递归由显式步数预算约束（`budget` 选项，耗尽抛 `BudgetExceededError`）

## API

```ts
import { parse, evaluate, Machine, MachineOptions } from './src/index.js';

evaluate('1 + 2 * 3');                        // 7n（解析 + 求值）
const program = parse('1 / 0');               // 仅解析，不报错
const m = new Machine(program, { budget: 1000 });
m.run();                                      // 抛 EvalError: division by zero

// 暂停 / 恢复：保存求值栈，恢复后与一次执行结果一致
while (!m.done) { m.step(); const snap = m.pause(); const m2 = Machine.restore(snap); }

// 检查实参不求值
m.thunks[0].state;                            // 'pending' | 'value' | 'error'
m.stats.thunkForces;                          // 实际求值次数（缓存失败不重复求值）
```

## 设计

- `src/lexer.ts` / `src/parser.ts`：词法与递归下降解析，产出带 `span` 的 AST，与执行完全分离。
- `src/machine.ts`：显式控制栈求值机（非递归 JS 调用栈），每步消耗 1 点预算；
  `pause()` 快照 `{node, value, mode, stack, env, budget}`，`Machine.restore()` 恢复继续。
- 惰性参数：`call` 时将实参表达式与调用点环境包成 `Thunk`；读变量时若 `pending`
  则压栈求值并缓存；求值出错时错误写入所有外层 `pending` thunk，再次读取直接抛出缓存错误。

## 测试

```
npm test    # tsc 构建 + node --test（Node.js 内置 test runner）
```

实际结果（Node v22.22.1，TypeScript 7.0.2，2026-10-06）：

```
✔ integer arithmetic with precedence
✔ division truncates toward zero
✔ arbitrary precision integers
✔ comparisons and equality
✔ parsing is separated from evaluation
✔ one parsed program can be evaluated many times
✔ type errors are reported
✔ ternary evaluates only the selected branch
✔ && and || short-circuit
✔ division by zero errors only when actually evaluated
✔ nested ternary and boolean combinations
✔ arguments are lazy: unused erroring argument is never evaluated
✔ argument is evaluated on first read and cached afterwards
✔ closures capture bindings, not copies of values
✔ captured lazy argument stays lazy inside the closure
✔ recursion is bounded by an explicit step budget
✔ call errors: arity and calling non-functions
✔ undefined variable error carries the source range
✔ undefined variable position tracks lines
✔ pause and resume matches a single uninterrupted run
✔ pausing at every single step still matches one run
✔ checking an unevaluated argument produces no error
✔ a cached failure is rethrown without re-evaluating
✔ nested lazy arguments each cache the same failure

# tests 4 个文件 / 24 个用例
# pass 24
# fail 0
```
