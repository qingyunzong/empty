# offline-orset

离线集合（OR-Set CRDT，observed-remove 语义），TypeScript 实现，仅依赖 Node.js 内置模块（`node:test` / `node:assert`），零运行时依赖。

## 语义保证

- **唯一 tag**：每次 `add` 生成全局唯一 tag（`replicaId:seq`，序号按副本严格递增）。
- **观察删除**：`remove` 只移除发起时本副本观察到的 tag；并发/未见的添加存活（add-wins），旧删除不会吞掉未见添加。
- **并集合并**：`merge` 对存活条目与墓碑分别取并（墓碑优先），满足交换律、结合律、幂等。
- **确认向量门控压缩**：`compact` 仅当**全部已知副本**的确认向量都覆盖某 tag 的添加事件时才回收其墓碑；`trackReplica` 可登记必须参与确认的成员（离线成员会阻止压缩）。
- **收敛**：消息乱序由逐副本缓冲+连续前缀时钟处理，重复消息由 `seq <= clock` 判重与墓碑幂等吸收；不同顺序、重复投递下各副本收敛到同一状态。

## 消息模型假设

与常规 CRDT 压缩一致：副本间采用带确认的可靠广播——未被确认的消息可能乱序或重复投递；已被全副本确认的事件不会再被重发。每条消息（add/remove/ack）都携带发送者的确认向量（向量时钟），兼作心跳。

## API 摘要

```ts
const a = new ORSet<string>("A");
const msg = a.add("x");          // -> AddMessage（含唯一 tag），广播给其他副本
const rm = a.remove("x");        // -> RemoveMessage | null（只含观察到的 tag）
a.apply(msg);                    // 应用远端消息：幂等、乱序安全
a.merge(other);                  // 状态并集合并
a.ack();                         // 确认向量心跳
a.compact();                     // 回收全副本已确认的墓碑，返回被回收的 tag
a.trackReplica("D");             // 登记必须参与确认的副本
a.values() / a.has("x") / a.size // 查询
a.snapshot(); ORSet.restore(s)   // 持久化快照 / 恢复
```

## 运行测试

```bash
npm test   # = tsc -p tsconfig.json && node --test "dist/test/*.test.js"
```

需要 `tsc`（TypeScript >= 5.6）与 Node.js（>= 18）。离线环境无 `@types/node`，`types/node-shims.d.ts` 声明了测试用到的最小 API 面。

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2，2026-10-05 执行 `npm test`：

```
# Subtest: dist/test/basic.test.js
ok 1 - dist/test/basic.test.js
# Subtest: dist/test/compaction.test.js
ok 2 - dist/test/compaction.test.js
# Subtest: dist/test/convergence.test.js
ok 3 - dist/test/convergence.test.js
# tests 3
# pass 3
# fail 0
```

逐条用例（15 个，全部通过）：

```
ok 每次添加生成全局唯一 tag
ok 删除只移除当时观察到的 tag
ok 删除不存在的值返回 null 且不产生状态
ok 删除后值消失，墓碑保留以吞掉晚到的添加
ok merge 为并集且幂等
ok merge 中墓碑优先：一侧删除并集后仍删除
ok 快照恢复后状态一致
ok 确认向量未收齐时压缩不回收任何墓碑
ok 全部副本确认后压缩回收墓碑，且重放旧添加不会复活
ok 登记的离线副本会阻止压缩，直到其确认到达
ok 新副本通过合并加入后与其他副本收敛
ok 删除先于添加到达（乱序），最终删除生效且各副本一致
ok 同一副本的添加乱序到达时被缓冲，前驱补齐后按序应用
ok 三副本随机操作 + 全消息乱序/重复投递后收敛
ok 多种子随机投递顺序均收敛到同一状态
```

## 目录结构

```
src/vector-clock.ts   向量时钟（连续前缀观察时钟）
src/orset.ts          OR-Set 本体：唯一 tag、观察删除、并集合并、确认向量门控压缩
src/index.ts          导出入口
test/                 node:test 测试（基本语义 / 收敛性 / 压缩）
types/node-shims.d.ts node:test 与 node:assert/strict 的最小类型声明
```
