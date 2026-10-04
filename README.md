# authorized-subscription

授权可见订阅库（TypeScript，仅使用 Node.js 内置库，零依赖）。

## 设计

- `DataStore`：内存数据仓库，每次变更递增 `dataVersion` 并通知订阅库。
- `SubscriptionLibrary` / `SubscriptionSession`：为每个订阅者维护**授权可见结果集**。
  数据变更或策略变更都会触发一次异步重评估（generation 单调递增）。
- `ControlledExecutor`：可控执行器。授权查询任务先入队不执行，由调用方按任意顺序
  显式完成，用于模拟异步授权查询的**乱序完成**。
- `AsyncAuthorizer`：把授权判定包装成执行器任务；`visibleSync` 提供**同步授权查询**，
  作为核对异步结果的基准（ground truth）。

## 核心保证

1. **策略撤销先发删除再发新数据**：同一评估周期内，所有 `delete` 消息先于任何
   `upsert` 消息发布（见 `SubscriptionSession.publish`，src/subscription.ts）。
2. **所有消息绑定版本**：每条消息携带会话内连续递增的 `version`，并附带
   `generation` 与 `policyVersion` 以便追溯。
3. **旧异步查询结果禁止发布**：只有最新 generation 的评估结果允许发布；
  乱序完成时，旧 generation 的结果到达即丢弃。

## 运行测试

```sh
npm test   # tsc 编译后运行 node --test
```

测试覆盖：初始可见集、数据变更重评估、撤销时删除先于新数据、乱序完成时旧结果
禁止发布、随机乱序完成与同步授权查询逐轮核对、会话关闭后不再发布。
实际结果见 TEST-RESULTS.md。
