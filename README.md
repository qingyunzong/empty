# 依赖数据集就绪世代

可导入的 TypeScript 数据集就绪协调器。生产者按 `(dataset, partition)` 发布
`schemaHash` 与单调递增的 `generation`；消费者声明依赖的数据集、分区、允许的
schema 集以及 `all`/`any` 聚合方式。协调器负责去重、乱序防护、撤回后重等与快照绑定。

## 快速开始

```ts
import { createDatasetReadinessCoordinator } from "./index.ts";

const coordinator = createDatasetReadinessCoordinator();

const task = coordinator.declareConsumer({
  id: "daily-rollup",
  mode: "all",
  requirements: [
    {
      dataset: "orders",
      partitions: ["p0", "p1"],
      schemaHashes: ["sha256:abc"],
    },
  ],
  onReady(snapshot) {
    console.log("ready", snapshot.entries);
  },
});

coordinator.publish({
  dataset: "orders",
  partition: "p0",
  schemaHash: "sha256:abc",
  generation: 41,
  producer: "orders-etl",
});

coordinator.publish({
  dataset: "orders",
  partition: "p1",
  schemaHash: "sha256:abc",
  generation: 41,
});

const snapshot = await task.waitForReady();
const bound = task.start();
```

## 信号

```ts
coordinator.publish({
  dataset: "orders",
  partition: "p0",
  schemaHash: "sha256:abc",
  generation: 42,
  producer: "orders-etl",
});

coordinator.withdraw({
  dataset: "orders",
  partition: "p0",
  generation: 42,
});
```

`generation` 必须是非负安全整数，并在同一个 `(dataset, partition)` 上单调递增。
协调器为每个分区保留世代高水位：

- 同一世代的重复发布返回 `duplicate`，不改变状态，也不触发任务。
- 低于高水位的发布或撤回返回 `stale`，不会复活旧数据，也不会误撤回新数据。
- 同世代但 schema/producer 不同返回 `conflict`。
- 撤回会删除当前发布但保留高水位，因此撤回后必须用更大的世代重新发布。

`publish`、`withdraw` 和 `signal` 都返回 `SignalResult`，其中 `triggered` 只包含本次
真正从 `waiting` 进入 `ready` 的任务，`updated` 包含就绪快照被刷新但未重复触发的任务。

## 消费者声明

```ts
const task = coordinator.declareConsumer("daily-rollup", {
  mode: "all",
  schemaHashes: ["sha256:abc"],
  requirements: [
    { dataset: "orders", partitions: ["p0", "p1"] },
    { dataset: "customers", schemaHashes: ["sha256:def", "sha256:ghi"] },
  ],
});
```

- 顶层 `mode` 在多个 `requirements` 之间取 `all` 或 `any`，默认 `all`。`any` 表示至少
  一个需求满足即可，快照包含所有已满足的需求。
- `partitions` 默认 `["*"]`；`"*"` 代表该数据集当前所有存活分区。
- `partitionMode` 控制同一需求内多个分区如何聚合，默认 `all`。`all` 要求每个指定分区
  就绪；通配 `"*"` 在 `all` 模式下要求当前每个存活分区都匹配允许的 schema。
  `any` 模式下只要一个指定分区匹配即可，快照包含所有可用候选分区。
- `schemaHashes`（别名 `schemas`）表示允许的 schema 集；省略表示接受任意 schema，
  空数组表示不接受任何 schema，包含 `"*"` 表示接受任意 schema。schema 按字符串精确匹配。
  可在消费者声明级设置默认 schema 集，需求级配置会覆盖该默认值。
- 声明可以省略 `id`，但必须至少包含一个需求。

信号可以先于消费者声明到达；声明时会立即评估现有发布，必要时同步调用 `onReady`。

## 任务生命周期

任务状态为 `waiting -> ready -> started`：

- `waiting`：依赖尚未满足。
- `ready`：依赖已满足，`snapshot()` 返回当前候选快照；此时仍可被撤回打回 `waiting`。
  未启动任务遇到更新且 schema 仍被允许的发布时会刷新候选快照，但不会再触发 `onReady`。
- `started`：调用 `start()` 后任务绑定当时的快照。此后新的发布或撤回不会改变该任务，
  也不会再次触发它。重复调用 `start()` 返回同一个不可变快照。

撤回发生在启动之前时，任务回到 `waiting` 并清空候选快照；条件再次满足会重新触发一次。
撤回发生在启动之后时，已启动任务继续使用旧快照。

`onReady` 在每次 `waiting -> ready` 转换时同步调用。重复和乱序信号不会造成同一就绪
周期内的重复触发；只有经过一次 `ready -> waiting` 后再次就绪，才算新的触发。
如果需要消除“就绪后、启动前被撤回”的窗口，可以在 `onReady` 中立即调用 `task.start()`。

## 等待与检查

```ts
const controller = new AbortController();
const snapshot = await task.waitForReady({ signal: controller.signal });

task.snapshot();     // 当前候选/已绑定快照
task.state;          // "waiting" | "ready" | "started"
task.triggerCount;   // 进入 ready 的次数
task.tryStart();     // 未就绪返回 null
task.unregister();   // 注销并拒绝仍在等待的 waitForReady
```

协调器还提供 `registerConsumer`、`registerTask`、`declareTask` 别名，以及
`getPublication`、`listPublications`、`inspectTask`、`listTasks`、`reset`。

## 校验

```bash
npm test
npm run typecheck
```

当前 Node 构建不内置 TypeScript 类型剥离，测试脚本会先用 `tsc` 将
`index.ts`、`src/` 和 `test/` 编译到 `.test-build/`，再用 Node 测试运行器执行。
