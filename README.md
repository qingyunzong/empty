# state-store

基于 TypeScript 与 Node.js 内置库的内存状态库，提供乐观并发事务。

## 事务语义

- **回调可 await**：`store.transaction(async (tx) => ...)` 等待异步回调完成。
- **写入仅记录暂存变化**：`tx.set` / `tx.delete` 只写入事务私有的暂存区，
  提交前外部 `store.get` 完全不可见（测试用可控等待门闩在事务挂起期间验证）。
- **基线版本冲突**：事务启动时捕获 `store.version` 作为基线；提交时若版本已变，
  整个事务冲突（`ConflictError`），暂存变化全部丢弃，一个键也不会写入。
- **回调返回后事务对象禁止读写**：回调返回即关闭事务，此后对保存的事务对象调用
  `get` / `set` / `delete` 均抛出 `TransactionClosedError`。
- **取消与提交只允许一个完成决议**：`commit()` 与 `cancel()` 共享单次决议，
  先完成者生效，之后的任何决议调用抛出 `TransactionSettledError`。
- 回调未自行决议时，存储在回调返回后自动提交；回调抛错则丢弃暂存并原样重抛。
- 提交以单次版本递增原子应用全部暂存变化；取消不触碰版本号。

## 使用

```ts
import { StateStore } from "./src/store.js";

const store = new StateStore();
await store.set("balance", 100);

await store.transaction(async (tx) => {
  const balance = (await tx.get("balance")) as number;
  await tx.set("balance", balance - 30); // 仅暂存，外部不可见
}); // 回调返回后自动提交；期间版本被改动则抛 ConflictError
```

## 运行测试

```sh
npm test   # tsc 编译到 dist/ 后用 node --test 运行
```

环境要求：Node.js（实测 v22.22.1）与 `tsc`（实测 TypeScript 7.0.2）。
运行时零依赖，仅使用 `node:test`、`node:assert/strict` 等内置模块；
`types/node-shim.d.ts` 为离线环境提供最小内置模块类型声明。

## 实测结果（2026-10-05，Node v22.22.1）

`npm test` 退出码 0，TAP 汇总：`# pass 1 / # fail 0`（文件级）。
直接运行编译产物 `node dist/test/store.test.js` 的明细：

```
ok 1 - commit applies staged writes atomically with a single version bump
ok 2 - transaction callback is awaitable and reads see own staged writes
ok 3 - external reads cannot see staged values while the transaction is pending
ok 4 - baseline version change makes the whole transaction conflict
ok 5 - saved transaction object forbids reads and writes after the callback returns
ok 6 - commit and cancel allow only one resolution
ok 7 - cancel discards staged changes and leaves version untouched
ok 8 - throwing callback discards staged changes and rethrows
# tests 8
# pass 8
# fail 0
```
