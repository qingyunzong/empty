# 网关配额组件

一个零依赖的 TypeScript 配额组件。每个网关节点在本地持有互不重叠的配额分片，先做本地预留，再把成功预留、提交和释放事件交给全局协调器对账。组件不依赖数据库或网络库，可直接嵌入网关进程，也可把事件批次交给已有的传输层。

## 核心约束

- **容量不超卖**：任一窗口内 `reserved + passed <= quota`。
- **分片隔离**：节点 `i` 持有 `shardLimit_i`，且 `sum(shardLimit_i) <= quota`。节点只在本地做准入，不需要每次请求都访问全局协调器。
- **漂移有界**：节点时钟通过 `synchronize(referenceNow)` 校正，校正量被限制在公开的 `maxClockDriftMs` 内。
- **失败原子性**：预留失败只更新本地失败计数，不产生事件、不写全局账本。
- **超时释放**：预留有 TTL，惰性检查和 `reconcile()` 都会释放过期预留，并生成全局可对账的 `release(timeout)` 事件。
- **对账幂等**：每个节点的事件带连续 `seq`，协调器忽略重复事件，重复投递不会重复扣减。
- **总量守恒**：`accepted = activeReserved + passed + released`，本地账本与对账后的全局账本都满足该等式。

## 窗口语义

所有事件使用半开区间 `(t - W, t]` 计数，`reserved` 和 `passed` 都占用配额，`released` 不占用。

时钟误差为 `D = maxClockDriftMs` 时，内部实际使用的窗口是：

```text
effectiveWindow = W + 2 * D
```

原因是校正后的时间戳 `t` 对应的真实时间可能落在 `[t-D, t+D]`。若每个长度为 `W+2D` 的有效窗口内事件数不超过配额，则任意长度为 `W` 的真实窗口内事件数也不会超过配额。`D = 0` 时退化为精确的 `W` 滑动窗口。

节点准入会检查**所有包含候选时间点的有效窗口**，而不只是 `(t-W, t]`。因此即使时钟回拨导致乱序写入，也不会把超卖事件塞进一个更晚的窗口。

## 快速使用

```ts
import {
  createQuotaCluster,
  ManualClock,
} from './index.js';

const reference = new ManualClock(0);
const cluster = createQuotaCluster({
  quota: 100,
  windowMs: 1_000,
  reservationTtlMs: 250,
  maxClockDriftMs: 20,
  nodes: [
    { id: 'gw-a', shardLimit: 50, physicalSkewMs: 5 },
    { id: 'gw-b', shardLimit: 50, physicalSkewMs: -5 },
  ],
  referenceClock: reference,
});

const result = cluster.reserve('gw-a', 'req-123');
if (result.ok) {
  // 业务处理...
  cluster.commit('gw-a', 'req-123');
} else {
  // result.reason: shard_exhausted | duplicate | invalid | closed
}

// 定时执行：校正时钟、释放超时预留、把本地事件写入全局账本
const report = cluster.reconcile();
const audit = cluster.audit();
if (!audit.ok || !audit.inSync) {
  // 记录 audit.violations，并触发告警
}
```

不传 `shardLimit` 时，配额会在节点间平均分配。也可以显式指定每个节点的分片上限，但总和不能超过全局配额。

## 独立嵌入节点

`QuotaNode` 接受任意 `Clock` 实现，适合每个网关进程单独实例化：

```ts
import { QuotaNode } from './index.js';

const node = new QuotaNode({
  id: 'gw-a',
  shardLimit: 50,
  windowMs: 1_000,
  reservationTtlMs: 250,
  maxClockDriftMs: 20,
  clock: { now: () => Date.now() },
});

node.synchronize(Date.now());
const result = node.reserve('req-123');
const outbox = node.drainEvents(); // 交给传输层投递到协调器
```

协调器的 `ingest(nodeId, events)` 可以直接消费这种批次：

```ts
cluster.ingest('gw-a', outbox);
```

同一批事件重复投递是安全的；重复的 `seq` 会被忽略。乱序到达的批次会按 `seq` 缓冲，缺口补齐后连续应用；长时间存在缺口时 `audit().inSync` 为 `false`。

## 预留生命周期

1. `reserve(id)`：先按节点当前校正时间清理过期预留，再检查重复 ID 和所有相关窗口；失败直接返回，不产生事件。
2. 成功预留写入本地 `reserved` 记录，并进入 outbox，等待对账。
3. `commit(id)`：把记录变为 `passed`，仍在原窗口内占用配额。
4. `release(id)`：显式取消，删除本地记录。
5. TTL 到期：下一次 `reserve`、`commit`、`release`、`tick`、`reconcile` 或 `audit` 时惰性释放，产生 `release(timeout)`。

TTL 只影响“预留是否继续占用配额”，不改变已经通过的请求的历史计数。释放后的预留不再属于 `reserved + passed`，因此可以安全复用其容量。

## 对账与守恒

协调器按节点分别维护全局镜像，并额外维护一个全局联合账本：

- 本地事件只有成功预留才会进入 outbox。
- 协调器应用事件前再次检查分片和全局窗口，异常会记录到 `violations`，且不会写入超限记录。
- `ingest` 按 `seq` 去重并缓冲乱序事件；`reconcile()` 会先校正时钟、释放超时预留，再拉取并应用 outbox。
- `audit()` 检查分片窗口上限、全局窗口上限、时钟漂移、本地/全局守恒和 outbox 是否清空。

守恒等式在节点和协调器两侧分别为：

```text
accepted = activeReserved + committed + releasedExplicit + releasedTimeout
accepted = liveReserved + committed + released
```

`compact()` 可以清理有效窗口之外的 `passed` 记录；只清理已经结算的记录，不影响预留守恒。

## 正确性论证

1. 节点 `i` 的每次成功预留都要求其本地账本在任意包含该时间点的有效窗口内不超过 `shardLimit_i`。由归纳法，节点 `i` 的任意有效窗口使用量始终不超过 `shardLimit_i`。
2. 分片互不重叠且 `sum(shardLimit_i) <= quota`，所以所有节点事件的并集在任意有效窗口内不超过 `quota`。
3. 有效窗口为 `W + 2D`，覆盖校正时间戳的 `±D` 真实时间不确定性，因此任意真实 `W` 窗口也不会超过 `quota`。
4. 失败预留路径在写入本地账本和 outbox 之前返回，所以不会产生全局事件。
5. 每个成功预留最终恰好进入 `activeReserved`、`passed`、`released` 三者之一；协调器镜像同一事件流，故对账后守恒等式成立。

## 测试

```bash
npm test
```

测试覆盖：

- 半开窗口边界、乱序候选时间点、滑动窗口最大重叠的暴力对照。
- 预留、提交、显式释放、超时释放和失败不写全局。
- 两个节点请求序列的**全部交错**（252 种）。
- 长度 5、9 个操作符的**全部操作序列**（59,049 条），每条序列逐步对照独立朴素滑动窗口模型的通过集合、剩余配额和记录状态。
- 单分片、6 个操作符、长度 5 的**全部操作序列**（7,776 条），直接对照全局朴素滑动窗口。
- 120 个随机种子 × 90 步的时钟推进、节点独立漂移、同步与对账交错；每步检查分片/全局上限、漂移界和守恒。
- 对账批次重复投递、乱序缓冲的幂等性，以及压缩后的守恒。

可用 `EXHAUSTIVE_DEPTH=4 npm test` 缩短穷举深度。

## 设计边界

- 分片是静态安全分区：节点 A 的空闲配额不会自动借给节点 B。这样本地预留无需全局同步即可严格保证总配额；若需要工作 conserving 的全局配额，需要额外的租借/回收协议。
- 对账是最终一致的：未对账的成功预留仍安全地受本地分片限制，只是全局视图会暂时滞后。`audit().inSync` 会显式暴露这一状态。
- 事件序列以 `(nodeId, seq)` 标识；节点重启后必须使用新的节点 ID 或引入 epoch，否则新序列会被旧协调器当作重复事件。
- 如果物理时钟偏移超过公开的 `maxClockDriftMs`，`synchronize()` 只能把校正量截断在界内，`withinBound` 会变为 `false`，`audit()` 也会报告违规；此时应把节点摘除或扩大公开界。
- `compact()` 以当前校正时间为水位；若随后时钟大幅回拨，已压缩的历史记录无法恢复，应只在时钟稳定或使用保守水位时调用。
