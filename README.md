# scoped-resource

TypeScript 测试资源作用域库：嵌套作用域、LIFO 清理、错误聚合、迟到获取防泄漏。
仅依赖 Node.js 内置模块（`node:test` / `node:assert`），无第三方运行时依赖。

## 语义

- **获取成功才登记**：`acquire(make, release)` 只有在 `make` 成功后才把
  `release` 登记进作用域；`make` 失败不会留下任何清理项。
- **嵌套作用域**：`new Scope(parent)` 挂到父作用域；关闭父作用域时先关闭
  子作用域（最新创建的优先），再按 LIFO 执行父作用域自己的清理项。
  手动关闭的子作用域会从父作用域摘除，不会被重复清理。
- **异常逆序清理全部且聚合错误**：`close()` 逐个 `await` 每个清理函数，
  即使某个失败也会继续执行其余全部；多处失败聚合为一个 `AggregateError`
  抛出，单处失败原样抛出。
- **异步迟到获取取消后仍须清理**：作用域关闭后，仍在途的 `acquire` 一旦
  解析出资源，会立即对其执行 `release`（资源不外泄），并向调用方抛
  `ScopeClosedError`；若迟到释放本身也失败，两者聚合为 `AggregateError`。
- **一次释放**：`close()` 幂等，并发/重复调用共享同一次清理过程，
  每个清理函数恰好执行一次。
- **`Scope.run(body)`**：自动关闭的便捷形式；body 异常与清理异常同时
  发生时聚合为一个 `AggregateError`。

## 用法

```ts
import { Scope } from "./src/scope.js";

const result = await Scope.run(async (scope) => {
  const db = await scope.acquire(openDb, (db) => db.close());
  const child = new Scope(scope);
  const conn = await child.acquire(connect, (c) => c.destroy());
  return runQueries(db, conn);
});
```

## 测试

```sh
npm test   # tsc 编译后运行 dist/test/*.test.js（node:test）
```

测试用手动构造的 `deferred` Promise 交错控制时序，验证：

- 逆序释放顺序（获取按解析顺序登记，释放严格 LIFO，且逐个 await）；
- 清理失败时全部清理项仍执行且错误聚合；
- 并发/重复 `close()` 只释放一次；
- 作用域关闭后迟到的获取仍被释放、无逃逸资源。

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2（全局 tsc），2026-10-05 运行。
`npm test` 退出码 0，实际输出摘要：

```
ok 1 - registration
ok 2 - cleanup order
ok 3 - error aggregation
ok 4 - nested scopes
ok 5 - late acquisition after close
ok 6 - exactly-once cleanup
ok 7 - Scope.run
1..7
# tests 15
# suites 7
# pass 15
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 58.47099
```

注：本环境的 `node --test <file>` 不回流嵌套 TAP 明细（仅文件级汇总，
退出码仍正确），故 `npm test` 改为直接执行编译后的测试文件以获得完整
逐条结果；两种方式的通过/失败判定一致。
