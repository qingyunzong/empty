# authorized-subscription

订阅库：维护**授权可见结果集**，纯 TypeScript + Node.js 内置库（`node:test` /
`node:assert`），零运行时依赖。

## 保证

1. **撤销先删后发**：策略撤销导致同一批次既有隐藏又有新增时，全部 `delete`
   消息先于任何 `add` 消息发布（`src/subscription.ts` 的 `publishDiff`）。
2. **版本绑定**：每条消息携带 `version`，从 1 开始严格逐条 +1，消费者可检测
   缺漏、重复与乱序。
3. **旧异步结果禁止发布**：授权检查经 `ControllableExecutor` 异步执行；每次变更
   开启新 generation，旧 generation 完成时被丢弃，绝不发布。
4. **乱序核对**：`ControllableExecutor` 可按任意顺序完成挂起任务，模拟乱序完成；
   每轮结束后用同步授权查询 `syncAuthorizedView` 对实时视图做对账（`reconcile()`）。

## 结构

- `src/types.ts` — `Item` / `Policy` / 带版本的 `Message`
- `src/executor.ts` — `ControllableExecutor`：可控执行器，支持任意顺序完成
- `src/subscription.ts` — `SubscriptionLibrary` 与同步真值 `syncAuthorizedView`
- `test/subscription.test.ts` — 5 个用例（撤销顺序、版本绑定、过期抑制、
  随机乱序对账、数据删除）
- `types/node-shims.d.ts` — 环境无网络装不了 `@types/node`，仅声明用到的内置 API

## 运行

```sh
npm test   # tsc 编译 + node --test
```

## 实际测试结果（2026-10-06，Node v22.22.1，tsc 7.0.2）

`npm test` 退出码 0：

```
> tsc -p tsconfig.json && node --test "dist/test/*.test.js"
ok 1 - dist/test/subscription.test.js
# pass 1
# fail 0
```

测试文件内 5 个用例全部通过（`node dist/test/subscription.test.js` 明细）：

```
ok 1 - policy revocation publishes deletes before any new data
ok 2 - every message is bound to a contiguous increasing version
ok 3 - stale async query results are never published
ok 4 - out-of-order completion reconciles with synchronous authorization queries
ok 5 - data removal under an unchanged policy emits a delete
# tests 5
# pass 5
# fail 0
```
