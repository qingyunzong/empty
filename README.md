# lease-broker-sim

模拟消息代理与处理端，验证「至少一次投递 + ID 事务去重 = 业务效果恰好一次」。
纯 TypeScript + Node.js 内置库（`node:test` / `node:assert`），零运行时依赖。

## 语义模型

- **租约领取**：`Broker.pull()` 以租约发放消息（`deliveryId` + `leaseExpiresAt`），
  租约过期未 ACK 自动重回队列重投，`attempt` 递增（`src/broker.ts`）。
- **ACK 与订阅世代**：每个订阅持有 `generation`，崩溃重启 / 重新订阅后 +1；
  ACK 必须携带当前世代，旧世代 ACK 一律拒绝（`stale-generation`）。
- **至少一次**：代理 `crash()` 丢失全部在飞租约；`crash({ loseAcked: true })`
  连已确认状态也丢失，已 ACK 消息仍会重投。
- **ID 事务去重**：`DedupStore.applyEffect()` 把业务效果与「消息 ID 已处理」标记
  放在同一事务原子提交；注入提交故障时整体回滚（`src/store.ts`）。
- **轨迹保留重复**：`TraceLog` 记录每次投递（含重复）、每次 ACK（含被拒）、
  每次事务提交/回滚，用于核对效果一次、轨迹留重（`src/trace.ts`）。

## 故障注入点

- 代理侧：`broker.crash()` / `broker.crash({ loseAcked: true })` / `broker.setDown(true)`。
- 处理端：`store.injectCommitFailure(n)` 使接下来 n 次事务提交失败回滚；
  `ConsumerHooks.beforeAck` 在「效果已提交、ACK 未发出」的窗口注入代理崩溃。

## 运行

```bash
npm test   # tsc 编译 + node --test（需全局可用的 tsc）
```

## 实际测试结果（2026-10-05，Node v22.22.1，TypeScript 7.0.2）

```
$ npm test
# Subtest: dist/test/broker.test.js        ok
# Subtest: dist/test/consumer.test.js      ok
# Subtest: dist/test/integration.test.js   ok
# tests 3  # pass 3  # fail 0
```

逐用例（11 个全部通过）：

```
broker.test.js
  ok 1 - 正常流程：领取后 ACK，不再重投
  ok 2 - 租约过期未 ACK 自动重投，attempt 递增
  ok 3 - 订阅世代更换后旧 ACK 无效，消息在新世代重投
  ok 4 - 重新订阅也会推进世代，旧 ACK 随之失效
  ok 5 - 崩溃丢失已确认状态时，已 ACK 消息按至少一次语义重投
  ok 6 - 代理不可用期间 pull / ACK 直接失败
consumer.test.js
  ok 1 - 无故障基线：每条消息效果恰好一次，无重投
  ok 2 - 处理端提交故障：事务回滚不发 ACK，重投后效果仍只一次
  ok 3 - 效果已提交但 ACK 时代理崩溃：旧世代 ACK 被拒，重投被去重抑制
  ok 4 - 代理丢失已确认状态导致已 ACK 消息重投，去重保证效果不重复
integration.test.js
  ok 1 - 三条消息三类故障：业务效果各一次，轨迹保留全部重复
```

端到端场景（`test/integration.test.ts`）核对的关键不变量：

- 3 条消息注入 3 类故障（处理端提交回滚、ACK 前代理崩溃、ACK 后丢失已确认状态）；
- 业务效果日志恰为 `["effect:a", "effect:b", "effect:c"]`，各一次；
- 轨迹保留全部 8 次投递（m1×3、m2×3、m3×2）、1 次事务回滚、2 次代理崩溃、
  1 次旧世代 ACK 被拒、4 次重复抑制、6 次 ACK 确认。
