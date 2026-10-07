# tailcall-interp

一个 TypeScript 表达式解释器库，支持函数/闭包、异常（`throw` / `try` / `catch` / `finally`）、
尾调用帧复用与帧数计量。求值器基于显式任务栈（trampoline），不消耗宿主调用栈，
任意深度的递归都不会触发宿主栈溢出。

## 运行

```sh
npm test        # 编译 (tsc) 并运行 node:test 测试
npm run typecheck
```

## 语言特性（`src/ast.ts`）

数字、布尔、变量、二元运算、`let`、`fun`（可命名以支持递归）、`call`、`if`、`seq`、
`throw`、`try/catch/finally`。通过 `E` 辅助对象构造 AST。

## 解释器语义（`src/interpreter.ts`）

- **显式帧**：每次函数调用分配 `Frame { id, name, env, pendingFinally }`，帧 id 单调递增，
  可在 trace 与异常对象中显式引用。
- **尾调用复用**：调用处于尾位置且当前帧 `pendingFinally === 0` 时，复用当前帧
  （帧 id 不变，`meter.reused` 递增），否则分配新帧。`try` 求值期间会给当前帧的
  `pendingFinally` 计数，因此有待执行 finally 时尾调用退化为普通调用，finally 仍在
  被调用者返回后正确执行。
- **finally 覆盖**：finally 正常完成时保留原结果/原异常；finally 自身抛错时，
  新异常覆盖原结果或原异常。
- **异常展开顺序**：`Thrown.frames` 记录异常展开经过的帧 id（自内向外）；
  `trace` 记录 `enter / reuse / exit / unwind / finally / catch` 事件，均携带帧 id，
  可用于核验异常传播顺序。
- **帧计量**：`meter = { allocated, reused, live, maxLive }` 分别表示累计分配帧数、
  尾调用复用次数、当前存活帧数、存活帧数峰值。

## API

```ts
import { E } from "./src/ast.ts";
import { run, evaluate, InterpretedError } from "./src/interpreter.ts";

const result = run(E.call(E.fun("loop", ["n"], /* ... */), E.num(100000)));
// result.status === "ok" | "throw"
// result.meter / result.trace / (result.value | result.error)

evaluate(expr); // 直接返回值；未捕获异常抛 InterpretedError（携带 Thrown）
```

## 测试覆盖（`test/interpreter.test.ts`）

- 基本求值、闭包词法作用域
- 帧计量精确性（分配数 / 峰值深度 / 复用数）
- 20,000 层非尾递归与 200,000 层尾递归，均不溢出宿主栈；尾递归 `maxLive === 1`
- 待执行 finally 禁止尾调用帧复用，且 finally 在被调用者退出后执行
- 异常自内向外逐帧展开，帧 id 顺序与 finally 执行顺序可显式核验
- finally 抛错覆盖原异常与原结果；非抛错 finally 保留原结果
