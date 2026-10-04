# tx-state-store

基于乐观并发控制的内存事务状态库。TypeScript 实现，仅使用 Node.js 内置模块
（`node:test` / `node:assert`），零运行时依赖。

## 语义

- **事务回调可 await**：`store.transaction(async (tx) => ...)` 接受同步或异步回调，
  返回的 Promise 在回调完成（并自动提交）后决议。
- **写入仅记录暂存变化**：`tx.set()` 只写入事务私有的暂存 Map，提交前外部
  `store.get()` 不可见；`tx.get()` 优先读暂存、回退到已提交值。
- **基线版本变动则整体冲突**：事务启动时记录基线版本，提交时若
  `store.version` 已变化则整个事务以 `ConflictError` 拒绝，暂存变化全部丢弃，
  不存在部分应用。
- **回调返回后事务对象禁止读写**：回调返回后事务被关闭，任何留存引用的
  `get` / `set` / `commit` / `cancel` 均抛 `TransactionClosedError`。
- **取消与提交只允许一个完成决议**：`commit()` 与 `cancel()` 先到者生效，
  后者（包括冲突失败后的任何操作）抛 `TransactionClosedError`。
- **可控等待验证隔离性**：测试用 `deferred()` 门闩将事务挂起在回调中，
  在门闩释放前断言外部读不到暂存值，释放并提交后断言可见。

## 使用

```ts
const store = new Store();
store.set('balance', 100);

await store.transaction(async (tx) => {
  const balance = tx.get('balance') as number;
  tx.set('balance', balance - 30); // 仅暂存，外部不可见
  // 回调返回后自动提交；若期间基线版本被外部修改则整体冲突
});
```

显式 `await tx.commit()` 或 `tx.cancel()` 可提前决议事务；两者只有一个能成功。

## 运行测试

```sh
npm test   # tsc 编译后由 node --test 运行 dist/test/store.test.js
```

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 退出码 0。逐测试明细（`node --test-reporter=spec dist/test/store.test.js`）：

```
✔ transaction callback is awaitable and staged writes commit after it returns (3.103211ms)
✔ staged writes are invisible to external readers while the transaction is held open (3.873096ms)
✔ tx.get reads own staged writes and falls back to committed values (0.234092ms)
✔ baseline version change causes whole-transaction conflict, nothing is applied (0.946773ms)
✔ cancel and commit allow only one resolution: cancel first, commit fails (0.334309ms)
✔ cancel and commit allow only one resolution: commit first, cancel fails (0.213856ms)
✔ a failed commit (conflict) settles the transaction; cancel afterwards fails (0.602207ms)
✔ transaction object saved after callback returns forbids reads and writes (0.433079ms)
✔ throwing callback rejects the transaction and applies nothing (0.437898ms)
✔ version only advances on committed writes (0.786475ms)
ℹ tests 10
ℹ pass 10
ℹ fail 0
```

## 备注

沙箱无网络，无法安装 `@types/node`，`types/node-shims.d.ts` 提供了测试用到的
`node:test` / `node:assert/strict` / `setImmediate` 的最小类型声明（仅编译期）。
