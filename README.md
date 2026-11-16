# 水印空闲分区重新激活

可导入的 TypeScript 事件时间水印协调库。按分区维护最大事件时间、乱序界、允许迟到和 idle 世代，并把各分区水位归并为单调的全局水印。

```ts
import {
  StreamEvent,
  WatermarkCoordinator,
  WatermarkPolicy,
} from "dlks-de-0249";

const coordinator = new WatermarkCoordinator(
  new WatermarkPolicy(5_000, 30_000, 60_000),
);

coordinator.observe("orders", new StreamEvent("orders", 120_000, 1_000, 1));
coordinator.observe("payments", new StreamEvent("payments", 110_000, 1_000, 1));

coordinator.markIdle("payments");
coordinator.getWatermark();        // 115_000，payments 不再阻塞
coordinator.refreshIdle(2_000);    // 按 arrival time 自动标记空闲分区

const checkpoint = coordinator.checkpoint();
coordinator.restore(checkpoint);   // 分区、idle 世代、触发序号一起恢复
```

## 语义

- 全局水印为所有活跃且已初始化分区 `maxTimestamp - outOfOrderness` 的最小值；未初始化分区和空闲分区不参与归并。
- 全局水印与触发序号严格单调。新增/删除分区、恢复旧检查点、修改乱序界都不会让水印回退。
- 空闲分区收到事件时自动重新激活。分区最大事件时间保持为真实观测值；全局归并会把落后的分区夹到已发出的水位，因此更旧的事件返回 `Late` 或 `TooLate`，也不会拖住后续进度。
- `allowedLateness` 只决定迟到事件是否仍被接受（`accepted` / `EventStatus`），不改变水位公式。
- 每次全局水印前进产生一个带递增 `sequence` 的 `WatermarkTrigger`；可通过 `onWatermark` / `onTrigger` 订阅，或读取 `getTriggers()`。

## API

- 配置：`WatermarkOptions`、`WatermarkPolicy`、`new WatermarkCoordinator(options | policy)`。
- 分区：`addPartition`、`removePartition`、`getPartition`、`getPartitions`、`markIdle`、`reactivate`。
- 事件：`observe(partition, timestamp | StreamEvent)`、`observe({ partitionId, timestamp })`、`recordEvent`、`processEvent`。
- 水位：`getWatermark`、`globalWatermark`、`getPartitionWatermark`、`activePartitionCount`、`onWatermark`。
- 检查点：`snapshot` / `checkpoint`、`restore`、`fromSnapshot`、`serialize`。

`WatermarkState` / `StreamEvent` / `EventStatus` 也作为独立 API 导出，便于接入已有事件时间算子。
