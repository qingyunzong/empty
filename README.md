# combined-request（组合请求库）

并发申请多个资源：任一请求失败或超时即通过 `AbortSignal` 取消其余请求；
已成功的资源按**逆申请顺序**逐个释放（每个资源至多释放一次）；
取消/超时后的**迟到成功**同样会被释放，且不改变最终返回的错误；
多个失败并存时，返回**申请序**最靠前的错误（超时记为 `TimeoutError`）。

仅使用 TypeScript + Node.js 内置库（`node:test` / `node:assert`），零运行时依赖。

## 用法

```ts
import { acquireAll, TimeoutError } from './src/combined.js';

const [db, cache] = await acquireAll([
  { acquire: (signal) => openDb(signal), release: (db) => db.close(), timeoutMs: 1000 },
  { acquire: (signal) => openCache(signal), release: (c) => c.quit() },
]);
```

- `acquire(signal)`：申请资源，应响应 `signal` 的 abort 以支持取消。
- `release(resource)`：释放资源，失败时按逆申请序逐个调用。
- `timeoutMs`：可选；超时记为 `TimeoutError`（含 `index` / `timeoutMs`），并取消其余请求。

注意：未设置 `timeoutMs` 且永不 settle 的 `acquire` 会让 `acquireAll` 一直等待。

## 测试

```sh
npm test   # tsc 编译到 dist/ 后用 node --test 运行
```

测试通过手动 Promise 交错（deferred 按受控顺序 resolve/reject）验证：
释放恰好一次、逆申请序释放、错误选择按申请序、迟到成功仍被释放且错误不变。

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2，2026-10-05 执行 `npm test` 通过。
逐用例明细（`node --test-reporter=spec dist/test/combined.test.js`）：

```
✔ all succeed: results in application order, nothing released
✔ failure cancels the rest; acquired released in reverse application order
✔ error selection follows application order, not chronological order
✔ late success after cancellation is released exactly once; error unchanged
✔ timeout cancels the rest and yields TimeoutError
✔ late success after timeout is still released; TimeoutError unchanged
✔ each acquired resource is released exactly once across multiple failures
✔ release errors do not mask the original error
ℹ tests 8 / pass 8 / fail 0
```
