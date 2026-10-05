# offline-or-set

离线优先的观测删除集合（OR-Set CRDT），TypeScript 实现，运行时仅依赖 Node.js 内置模块，零 npm 依赖。

## 语义保证

- **唯一 tag**：每次 `add` 用 `(replicaId, seq)` 逻辑时钟打上全局唯一 tag，同一值多次添加产生多个独立 tag。
- **观测删除**：`remove` 只 tombstone 删除那一刻本地观测到的 tag；并发/未见的添加不受影响——旧删除不会吞掉未见的新添加（add-wins）。
- **并集合并**：`merge` 对存活条目与 tombstone 取并集（再扣除被 tombstone 的 tag），满足结合律、交换律、幂等， gossip 任意顺序、任意次数都收敛。
- **乱序/重复消息**：每个变更都是携带 `(replicaId, seq)` 的 op。重复 op 被丢弃；同一副本的乱序 op 先缓冲、缺口补齐后按序冲刷。op 效果本身幂等且可交换，集合状态与投递顺序无关。
- **向量化压缩**：`compact(acks)` 仅在收到**全部已知副本**的确认向量（version vector）后才执行；任一副本缺失则拒绝并抛错。只有当所有确认向量的逐分量最小值（meet）覆盖产生某 tombstone 的 remove op 时，该 tombstone 才被丢弃——即所有副本都已应用该删除，没有任何副本还可能持有该 tag，杜绝复活。

## API 概览

```ts
import { ORSet } from 'offline-or-set';

const a = new ORSet<string>('A');
const op1 = a.add('x');          // -> 广播给对端
const op2 = a.remove('x');       // 只移除当前观测到的 tag
b.apply(op1);                    // 对端应用（幂等、容忍乱序）
a.merge(b.toState());            // 并集合并
a.compact({ B: b.versionVector(), /* ...所有已知副本 */ });
```

- `add(value)` / `remove(value)`：本地变更，返回待广播的 op。
- `apply(op)`：应用远端 op；返回是否推进了状态。
- `merge(other | state)`：并集合并另一副本的状态。
- `versionVector()` / `knownReplicas()`：导出确认向量 / 已知成员。
- `compact(acks)`：全员确认后压缩 tombstone，返回丢弃数量。
- `toState()` / `ORSet.fromState(state)`：JSON 可序列化快照（持久化/传输）。
- 观测值用 `keyOf`（默认 `JSON.stringify`）做键，对象值可用自定义键函数。

## 成员与压缩的前提

副本通过互相收到 op（含空 remove 心跳）得知彼此存在；`compact` 要求 `acks` 覆盖所有**已知**副本。压缩安全性的前提是成员集合静态（或新成员以全新状态加入），这是 tombstone 压缩的标准假设。

## 测试

```sh
npm test   # = tsc 编译 + node --test（Node 内置测试运行器）
```

需要环境中有 `tsc`（TypeScript 编译器）；运行与测试本身只用 Node.js 内置模块（`node:test`、`node:assert`）。

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2，2026-10-05 执行 `npm test`：

```
    ok 1 - adds and removes values
    ok 2 - stamps every add with a unique tag, so re-add survives an older remove
    ok 3 - remove of a value never observed is a no-op that still advances the clock
    ok 1 - concurrent remove (observing nothing) does not kill a remote add
    ok 2 - stale remove only kills the tags it observed, not later re-adds elsewhere
    ok 1 - buffers out-of-order ops and flushes them when the gap fills
    ok 2 - ignores duplicate ops
    ok 3 - converges across replicas under shuffled, duplicated delivery (seeded fuzz)
    ok 1 - merges diverged replicas by union of adds and observed removes
    ok 2 - is commutative and idempotent on snapshots
    ok 1 - drops tombstones once every replica confirms the remove
    ok 2 - refuses to compact without every known replica's confirmation vector
    ok 3 - keeps tombstones a lagging replica has not confirmed
    ok 4 - is safe against resurrection: all replicas confirmed, so none can reintroduce the tag
    ok 1 - round-trips through a JSON state snapshot
# tests 15
# suites 6
# pass 15
# fail 0
```

15/15 通过。其中收敛性用确定性种子 fuzz（4 副本 × 300 随机 op，随机乱序 + 30% 重复投递）验证所有副本最终状态、版本向量、tombstone 数完全一致。
