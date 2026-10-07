# scriptlet

一个沙箱化脚本解释库（TypeScript + Node.js 内置库，零运行时依赖）。

## 特性

- **数据类型**：整数、字符串、布尔、null、列表、字典（null 原型对象，无继承属性）。
- **受限循环**：仅 `while` 循环；每次求值与每次循环回边各计 1 步，受预算约束。
- **计步预算**：`budget` 耗尽时抛出 `BudgetExhausted`，解释器未闭合状态就地放弃，
  不产出任何结果。
- **事务写**：`set(key, value)` 仅写入缓冲区；脚本正常退出时才发布到宿主 `Map`，
  任何错误（含预算耗尽、解析失败、运行时错误）都不会泄漏部分修改。
- **无宿主对象访问**：脚本值均为纯数据，无函数值、无原型链查找（字典用
  `Object.create(null)` 且只查自有属性），无全局对象（`process`/`globalThis` 不可达）。
- **深嵌套防护**：解析器对表达式/块嵌套设硬上限（`MAX_DEPTH = 200`），
  超限抛 `ParseError`；求值阶段另受步数预算双重约束。

## 语言概览

```js
let x = 2 + 3 * 4;
let a = [1, 2, 3];
let d = {"name": "n", "nums": a};
let i = 0;
while (i < 10) {
  set("sum", i);          // 事务写，正常退出才发布
  i = i + 1;
}
if (x >= 10 && !(x < 0)) { return d["nums"][1]; } else { return null; }
```

运算符：`+ - * / %`（整数截断除法）、`< <= > >= == !=`、`&& || !`、
索引 `e[e]`、内置 `len(e)`。语句：`let`、赋值、`while`、`if/else`、
`set(k, v)`、`return`、`//` 注释。

## API

```ts
import { runScript } from 'scriptlet';

const host = new Map<string, Value>();
const result = runScript(src, { budget: 10_000, host });
// result: { value, steps, writes }
// 失败时抛 BudgetExhausted / ParseError / ScriptError，host 保持不变
```

## 构建与测试

```sh
npm test   # tsc 编译 + node --test
```

注：`types/node-shims.d.ts` 为 `node:test` / `node:assert` 的本地最小类型声明，
用于离线环境（无需下载 `@types/node`）。

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2。`npm test` 退出码 0；
测试文件直接运行的 TAP 输出（2026-10-07 实测）：

```
ok 1 - integers, arithmetic, variables
ok 2 - lists, dicts, indexing, len
ok 3 - dict/list equality and string concat
ok 4 - while loop with back-edge counting
ok 5 - if/else and comparisons
ok 6 - transactional writes publish on normal exit
ok 7 - budget exhaustion inside loop leaves host untouched
ok 8 - budget boundary: exact steps succeed, one fewer fails
ok 9 - malicious deep nesting: no partial modification leaks
ok 10 - runtime error after set() does not commit
ok 11 - no host object access: prototypes and globals unreachable
ok 12 - set() requires a string key
ok 13 - program without return yields null
# tests 13
# pass 13
# fail 0
```
