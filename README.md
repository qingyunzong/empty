# tail-safe-interp

一个小型树遍历解释器（TypeScript），运行在**显式栈机**上：客户程序的调用帧与续体
（continuation）都存放在堆上的数组里，主循环是扁平的 `for (;;)`，因此客户代码任意
深度的递归都不会消耗宿主（JS）调用栈。

## 语言特性

- 具名函数（支持递归与互递归）、`let` 词法作用域、`if`、`begin`
- 内建运算：`+ - * = < > <= not log`
- 异常：`throw`、`try/catch`、`try/finally`、`try/catch/finally`

## 核心语义

### 尾调用与帧复用

调用发生时，若**当前帧的续体栈为空**（即被调用函数的返回值就是当前帧的返回值），
该调用是严格尾调用：直接**复用当前帧**（帧 id 不变、不增加深度），否则分配新帧。

由于 `try/finally` 会把 finally 续体压入当前帧的续体栈，"有待执行的 finally"会自然
使续体栈非空，从而**禁止帧复用**——新帧被分配，被调函数返回或抛错后 finally 仍会
执行。这正是"尾调用只有无待执行 finally 才复用调用帧"的规则（待执行的 catch 处理
器同理阻止复用）。

### finally 覆盖语义

- 正常完成：先执行 finally 体，再恢复原值继续（`try{42}finally{...}` 结果仍是 42）。
- 异常展开：先执行 finally 体，再重新抛出原异常。
- **finally 体自身抛错**：新的异常丢弃保存原结果的 resume 续体，**覆盖**原有结果
  （无论是正常值还是在飞异常）。

### 帧计量

`run()` 返回 `metrics`：

| 字段        | 含义                                       |
| ----------- | ------------------------------------------ |
| `allocated` | 新分配的帧数（含初始 `<main>` 帧）         |
| `reused`    | 尾调用复用次数（帧 id 不变）               |
| `maxDepth`  | 同时存活的帧数峰值                         |

### 显式帧引用与异常顺序

未被捕获的异常以 `ScriptError` 抛出，其 `trace: FrameRef[]` 按**展开顺序**（最内层
在前）记录每一帧的 `{ id, name }`。帧 id 单调分配且尾调用复用保持 id 不变，因此测试
可以精确核验：

- 普通调用链 `a→b→c` 抛错：`trace` 为 `[c, b, a, <main>]`，id 各不相同；
- 1 万层尾递归后抛错：`trace` 只有**一个**条目（单帧复用的直接证据）；
- finally 禁止复用时：每层一个帧，`trace` 逐层列出，且 `log` 输出证明 finally
  按最内层优先的顺序执行。

## API

```ts
import { run, fn, call, if_, op, lit, sym, try_, throw_ } from 'tail-safe-interp';

const loop = fn('loop', ['n', 'acc'],
  if_(op('=', sym('n'), lit(0)),
    sym('acc'),
    call('loop', op('-', sym('n'), lit(1)), op('+', sym('acc'), sym('n')))));

const r = run({ defs: [loop], main: call('loop', lit(200_000), lit(0)) });
// r.value   === 20000100000
// r.metrics === { allocated: 1, reused: 200001, maxDepth: 1 }
```

`run(program, { fuel })` 可设置步数上限，防止失控程序死循环。

## 开发

```sh
npm test   # tsc 编译 + node --test 运行全部测试
npm run build
```

无第三方运行时依赖；测试使用 Node 内置 `node:test`。
