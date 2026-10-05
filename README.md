# log-compaction

基于**副本确认向量**的日志压缩库。TypeScript 编写，运行时仅依赖 Node.js
内置模块（`node:fs` / `node:path`），无任何 npm 运行时依赖。

## 核心语义

- **按确认向量压缩前缀**：每个活副本持久确认一个 LSN（ack），压缩点为
  所有活副本 ack 的最小值（`compactionHorizon`）。`compact()` 先在压缩点
  持久化快照，再物理删除已全确认的前缀，LSN 单调不复用。
- **副本注销持久记入纪元**：注册 / 注销以纪元记录（递增 epoch）追加到
  `epochs.jsonl` 并 fsync，先生效于磁盘再生效于内存。崩溃重放纪元日志后，
  已注销副本保持缺席，其陈旧 ack 不会继续阻塞压缩。
- **新副本须先加载快照**：历史被回收后（`log.startLsn > 1`），以零向量注册
  会被 `ZeroVectorRegistrationError` 拒绝——零向量会把压缩前沿拖回已回收
  历史。新副本必须持 `takeSnapshot()` 的句柄加入，ack 从快照 LSN 起步；
  早于回收边界的快照被 `StaleSnapshotError` 拒绝。
- **剩余日志可恢复全部活副本**：`recoverReplica(id)` 用「≤ ack 的最新快照
  + 日志保留后缀」重建任意活副本的完整状态；事件模拟对每个事件后的每个
  活副本校验该重建结果与全量Oracle模型逐键一致。

## 目录结构

```
src/
  log.ts        # 追加式持久日志，前缀截断（压缩）
  registry.ts   # 副本注册表：纪元日志持久化成员变更 + ack 检查点
  snapshot.ts   # 版本化快照存储（snapshot-<lsn>.json + index）
  compactor.ts  # 压缩点 = 活副本 ack 向量最小值（纯函数）
  system.ts     # 门面：追加 / ack / 注册 / 注销 / 压缩 / 恢复
test/
  log.test.ts / registry.test.ts / system.test.ts   # 单元测试
  simulation.test.ts                                # 确定性事件模拟
```

## 使用示例

```ts
import { LogCompactionSystem } from "./src/index.js";

type State = Record<string, number>;
const reducer = (s: State, op: { key: string; value: number }): State => ({
  ...s,
  [op.key]: op.value,
});

const sys = LogCompactionSystem.open("./data", reducer, {});
sys.registerReplica("replica-1");            // 历史完整时允许零向量
const lsn = sys.append({ key: "a", value: 1 });
sys.ackReplica("replica-1", lsn);
sys.compact();                               // 回收全确认前缀（先落快照）

const snap = sys.takeSnapshot();             // 新副本：先加载快照
sys.registerReplica("replica-2", snap);      // ack 从快照 LSN 起步
sys.deregisterReplica("replica-1");          // 持久记入纪元日志

const recovered = sys.recoverReplica("replica-2"); // 快照 + 剩余日志重建
```

## 持久化布局

```
<dir>/
  log/log.jsonl            # 追加式日志（截断时原子重写）
  log/meta.json            # { startLsn, lastLsn }
  registry/epochs.jsonl    # 纪元日志：注册/注销，追加 + fsync
  registry/acks.json       # ack 向量检查点（原子更名）
  snapshots/snapshot-<lsn>.json + index.json
```

## 测试

```sh
npm test    # tsc 编译 + node --test（仅需全局 tsc，无 npm 依赖安装）
```

- 单元测试覆盖：日志截断与重开、纪元持久化、零向量拒绝、快照加入、
  崩溃恢复后剩余日志可恢复全部活副本。
- 事件模拟（`test/simulation.test.ts`）：3 个确定性种子 × 400 个随机事件
  （追加 / ack / 压缩 / 注册 / 注销 / 崩溃重启），每个事件后校验：
  1. 每个活副本的未确认后缀完整（`startLsn <= ack + 1`）；
  2. 每个活副本可由剩余日志重建到 Oracle 全量状态；
  3. 压缩前沿不越过最慢活副本；
  4. 崩溃重启后成员、ack 向量、日志边界与崩溃前一致。

实际运行结果见 [TEST_RESULTS.md](./TEST_RESULTS.md)。
