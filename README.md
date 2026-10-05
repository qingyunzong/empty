# lease-broker-sim

模拟消息代理：租约领取（lease fetch）、ACK、租约到期重投（at-least-once）；
订阅世代（generation）更换后旧 ACK 失效；处理端按消息 ID 在同一事务内去重，
业务效果恰好一次，投递轨迹保留重复记录。仅使用 TypeScript + Node.js 内置库
（`node:test`、`node:assert`、`node:crypto`），零第三方依赖。

## 结构

- `src/broker.ts` — 代理：`publish` / `subscribe` / `fetch`（租约）/ `ack`（按世代校验）/
  `resubscribe`（世代 +1，召回未决租约）/ 租约到期清扫重投；`beforeAck` 钩子注入代理侧 ACK 故障。
- `src/store.ts` — 事务账本：去重表与业务写入同一事务提交；`beforeCommit` 钩子注入提交故障，
  抛出即整体回滚，不留部分效果。
- `src/consumer.ts` — 消费者：拉取→幂等应用→ACK；追加式轨迹记录每次投递
  （`applied` / `duplicate` / `rolled-back` × ACK 结果），重复投递在轨迹中可见。
- `src/faults.ts` — 确定性故障注入器 `failTimes(n)`。
- `test/broker.test.ts` — 租约/ACK/世代/重投语义。
- `test/consumer.test.ts` — 故障注入下的端到端核对：业务效果一次、轨迹保留重复。

## 运行

```sh
npm test   # tsc 编译 + node --test
```

## 实际测试结果（2026-10-05，Node v22.22.1）

`npm test` 输出摘要：

```
# Subtest: dist/test/broker.test.js
ok 1 - dist/test/broker.test.js
# Subtest: dist/test/consumer.test.js
ok 2 - dist/test/consumer.test.js
# tests 2
# pass 2
# fail 0
```

逐条用例（直接运行各测试文件）：

```
ok 1 - lease fetch then ACK: message is delivered exactly once
ok 2 - unacknowledged lease expires and the message is redelivered (at-least-once)
ok 3 - generation change invalidates old ACKs; new-generation ACK works
ok 4 - broker-side ACK failure keeps the lease for redelivery
# tests 4
# pass 4
# fail 0
---
ok 1 - broker ACK failure: business effect applied once, trace keeps the duplicate
ok 2 - consumer commit failure: transaction rolls back, retry applies once
ok 3 - generation change mid-processing: stale ACK rejected, redelivery deduped
ok 4 - mixed faults across a batch: every transfer lands exactly once
# tests 4
# pass 4
# fail 0
```

8/8 通过。关键断言示例：代理 ACK 故障场景下余额恰为单次入账（50），
轨迹含 `[1, applied, broker-failed]` 与 `[2, duplicate, acked]` 两条记录。
