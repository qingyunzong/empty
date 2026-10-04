# scoped-resource

TypeScript 资源作用域库,仅依赖 Node.js 内置模块(`node:test` / `node:assert`),零运行时依赖。

## 语义

- **嵌套作用域**:`scope.child()` 作为终结器登记进父作用域,父关闭时子作用域先关闭,整体按登记逆序清理。
- **成功才登记**:`acquire` 的获取函数抛错或拒绝时,释放器不登记、不调用。
- **异常聚合清理**:`close()` 逆序执行全部终结器,单个失败不中断其余清理,所有清理错误聚合为 `AggregateError`;`Scope.run` 中 body 抛错时,body 错误与清理错误一起聚合。
- **迟到获取仍清理**:获取 Promise 在作用域关闭后才完成的,立即执行释放并抛 `ScopeClosedError`,资源不逃逸;关闭后再调用 `acquire` 直接拒绝且不触发获取函数。
- **恰好释放一次**:状态检查与登记之间无 `await`(同步原子),并发/重复 `close()` 共享同一次清理。

## 使用

```ts
import { Scope } from "./src/scope.js";

await Scope.run(async (scope) => {
  const db = await scope.acquire(openDb, (db) => db.close());
  const child = scope.child();
  const tx = await child.acquire(() => db.begin(), (tx) => tx.rollback());
  // ...
});
```

## 测试

```sh
npm test   # tsc 编译后运行 node --test
```

测试通过手动 `deferred` Promise 交错控制异步时序,验证清理顺序、恰好一次释放与无逃逸资源(`Tracker.live` 集合归零)。

## 实际测试结果

环境:Node.js v22.22.1,TypeScript 7.0.2,2026-10-05 执行 `npm test` 通过(exit 0):

```
✔ 嵌套作用域:父关闭时按逆序清理子作用域与全部资源
✔ 获取失败不登记:释放器不被调用,其余资源照常清理
✔ body 异常:逆序清理全部资源,body 错误与清理错误聚合
✔ close 聚合多个清理错误且不中断逆序清理
✔ 交错获取:手动控制完成顺序,释放严格按登记逆序
✔ 迟到获取:关闭后才完成的获取仍被清理,资源不逃逸
✔ 单次释放:并发与重复 close 共享同一次清理
✔ 关闭后获取:直接拒绝且不触发获取函数
✔ 子作用域独立关闭不影响父作用域其余资源
ℹ tests 9 / pass 9 / fail 0
```
