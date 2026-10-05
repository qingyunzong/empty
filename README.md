# miniscript-interpreter

一个沙箱化脚本解释库（TypeScript / Node.js 内置库，零运行时依赖）。
脚本只能操作整数、列表、字典，循环受步数预算约束，**无任何宿主对象访问**
（语言中没有函数调用、属性访问、FFI 或全局宿主绑定）。

## 构建与测试

```sh
npm test   # = tsc -p tsconfig.json && node --test dist/test/*.test.js
```

## 语言概览

```
let x = 1;                  // 声明
x = x + 1;                  // 赋值（目标必须已存在）
let xs = [1, 2, 3];         // 列表
let d = {"k": [1, 2]};      // 字典（键为字符串字面量）
xs[0] = 9;                  // 下标赋值：持久化更新（见下）
d["k"][1] = 8;              // 嵌套路径赋值
if (x > 1) { ... } else { ... }
while (x < 10) { ... }      // 支持 break / continue
transaction { ... }         // 事务块（可嵌套）
rollback;                   // 中止最内层事务
// 行注释
```

- 运算符：`+ - * / %`（整数，截断除法，溢出/除零报错）、`== != < <= > >=`、`&& || !`、`-x`。
- `+` 也用于列表拼接；`==` 对列表/字典做深比较。
- 真值：非零整数、非空字符串/列表/字典为真；比较与逻辑运算结果为 `1`/`0`。
- 解析器有最大嵌套深度（默认 200，`parse(src, maxDepth)` 可调），
  病态深嵌套输入得到 `ParseError` 而非栈溢出。

## 步数预算

- 每个表达式求值计 1 步，每次循环回边（while 每次回到条件判断）计 1 步。
- 预算在解释器生命周期内累计（`stepsUsed` / `stepBudget` 可查，`refuel(n)` 可补充）。
- 预算耗尽抛出 `BudgetExhaustedError`，并**保留未闭合状态**：
  未闭合的事务帧不清除，可通过 `txDepth`、`pendingWrites()` 检查，
  用 `abortUnclosed()` 显式丢弃；解释器 `refuel` 后仍可继续使用。

## 事务语义

- `transaction { ... }` 内的所有写入进入当前事务帧的覆盖层，
  **仅在块正常退出时**向外层（父事务或全局发布存储）发布。
- 嵌套事务逐级向外发布。
- `rollback;` 丢弃最内层事务的写入并继续执行外层。
- 普通运行时错误（除零、类型错误等）回滚当前事务帧。
- 预算耗尽时事务帧**保留但未发布**——已发布的全局存储（`get()`）绝不受部分写入污染。
- 下标赋值是持久化（写时复制）更新：旧别名永远看不到新值，
  因此事务内对共享列表/字典的修改不可能泄漏到已发布状态。

## 宿主 API

```ts
import { Interpreter, toJS } from './src';

const interp = new Interpreter({ budget: 10_000 });
interp.run('let a = [1, 2]; transaction { a[0] = 9; }');
interp.get('a');            // 已发布存储中的值（深拷贝）
interp.getVisible('a');     // 脚本视角（含未提交事务写入）
interp.pendingWrites();     // 各未闭合事务帧的待发布写入快照
interp.abortUnclosed();     // 丢弃未闭合事务帧
interp.refuel(1000);        // 补充步数预算
```

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2，2026-10-05 运行。

```
$ npm test
> tsc -p tsconfig.json && node --test dist/test/*.test.js
ok 1 - dist/test/interpreter.test.js
# pass 1  # fail 0

$ node dist/test/interpreter.test.js   # 逐条明细
ok 1 - integers: arithmetic, precedence, comparison, logic
ok 2 - lists: literals, indexing, concat, nesting
ok 3 - dicts: literals, string keys, nested access
ok 4 - index assignment is persistent: no aliasing leaks between variables
ok 5 - while loops: iteration, break, continue
ok 6 - step counting: every evaluation is charged deterministically
ok 7 - step counting: loop back-edges are charged
ok 8 - budget exhaustion stops infinite loops and reports usage
ok 9 - budget exhaustion preserves unclosed transaction state without publishing
ok 10 - malicious deep nesting: 150 unclosed transactions leak no partial writes
ok 11 - transaction publishes writes only on normal exit
ok 12 - nested transactions publish outward level by level
ok 13 - rollback discards only the innermost transaction
ok 14 - runtime error inside a transaction rolls its writes back
ok 15 - no host object access: calls and property access do not exist
ok 16 - undefined variable and type errors are runtime errors
ok 17 - pathological nesting is rejected by the parser, not by stack overflow
ok 18 - deep equality for == on lists and dicts
# tests 18
# pass 18
# fail 0
```

其中第 10 条为恶意深嵌套用例：脚本打开 150 层嵌套事务，
在最内层改写 `victim` 并新增 `leak` 后进入死循环烧光预算；
断言全局发布存储中 `victim` 保持原值、`leak` 不存在，
同时 150 个未闭合事务帧全部保留可供检查，无任何部分修改泄漏。
