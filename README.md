# combined-acquire

组合请求库：同时申请多个资源，任一请求失败或超时即取消其余；
已成功（含迟到成功）的资源按逆申请顺序各释放一次，返回错误按申请顺序选择。

仅使用 TypeScript + Node.js 内置库（`node:test` / `node:assert`），无第三方依赖。

## 语义

`acquireAll(requests, options?)` 并发发起所有 `acquire`：

- 每个 `acquire` 收到一个 `AbortSignal`；任一请求失败或超时（`timeoutMs`）时，
  立即 abort 其余请求的 signal。
- 无论成败，都会等待所有 `acquire` 真正落定：取消/超时后“迟到”的成功
  同样会被记录并释放，迟到的失败也不会改变已选定的错误。
- 失败时：所有已获得的资源按**逆申请顺序**各释放**恰好一次**，
  然后抛出**申请顺序中下标最小**的失败原因（原错误对象，超时为
  `AcquireTimeoutError`）。释放过程中的异常不中断其余释放，
  会挂在抛出错误的 `releaseErrors` 属性上。
- 全部成功时：按申请顺序返回资源数组，不调用任何 `release`。

## 用法

```ts
import { acquireAll } from './src/combinedAcquire.js';

const resources = await acquireAll(
  [
    { acquire: (signal) => openConnA(signal), release: (c) => c.close() },
    { acquire: (signal) => openConnB(signal), release: (c) => c.close() },
  ],
  { timeoutMs: 1000 },
);
```

## 测试

```
npm test   # tsc 编译后运行 node:test 测试
```

测试通过手动控制的 deferred Promise 交错，验证：释放恰好一次、
逆申请顺序释放、取消信号传播、超时语义、迟到成功/失败的处理、
以及错误选择按申请顺序。

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
# Subtest: 全部成功：按申请顺序返回结果，不释放任何资源
ok 1 - 全部成功：按申请顺序返回结果，不释放任何资源
# Subtest: 空请求列表：返回空数组
ok 2 - 空请求列表：返回空数组
# Subtest: 任一失败：取消其余请求，已成功资源按逆申请顺序释放
ok 3 - 任一失败：取消其余请求，已成功资源按逆申请顺序释放
# Subtest: 多个失败：错误选择按申请顺序（下标最小者）
ok 4 - 多个失败：错误选择按申请顺序（下标最小者）
# Subtest: 超时：视为失败并取消其余，迟到成功必须释放且不改变返回错误
ok 5 - 超时：视为失败并取消其余，迟到成功必须释放且不改变返回错误
# Subtest: 迟到失败：不改变已按申请序选定的错误
ok 6 - 迟到失败：不改变已按申请序选定的错误
# Subtest: 取消后落定的资源：释放恰好一次（手动交错验证）
ok 7 - 取消后落定的资源：释放恰好一次（手动交错验证）
1..7
# tests 7
# pass 7
# fail 0
```
