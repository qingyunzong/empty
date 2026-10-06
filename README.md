# stream-watermark-sim

事件驱动的流模拟库：计算活跃分区的最小水位（watermark），空闲分区通过
**显式事件**声明并排除，绝不依赖墙钟猜测；早于已公布水位的迟到/恢复数据
一律拒绝并记录；重放事件流可输出全局水位轨迹并核验单调性。

## 事件模型

- `data(partition, eventTime)` — 分区数据，携带事件时间
- `idle(partition)` — 显式声明分区空闲，随即从最小值计算中排除
- `active(partition)` — 显式声明分区恢复活跃，重新纳入最小值计算

数据到达空闲分区也会将其重新激活（到达的数据本身就是明确的活跃信号）。

## 语义

- 全局水位 = 所有活跃且已有数据的分区中 `max(eventTime)` 的最小值；
  仅在严格前进时发布新水位。
- `eventTime < 已公布水位` 的数据被拒绝（记录为 `LATE_DATA`），不修改任何状态。
- `WatermarkTracker.replay(events)` 返回 `{ trajectory, rejections, finalWatermark }`，
  其中 `trajectory` 记录每次发布的 `{ atEventIndex, watermark }`；
  若检测到水位回退会抛出异常（单调性核验）。

## 使用

```ts
import { WatermarkTracker, data, idle } from "./src/index.js";

const result = WatermarkTracker.replay([
  data("p0", 5),
  data("p1", 100),
  idle("p0"),     // p0 排除后水位推进到 100
  data("p1", 3),  // 3 < 100，拒绝并记录
]);
console.log(result.trajectory, result.rejections);
```

## 测试

```sh
npm test   # tsc 编译后运行 dist/test 下的 node:test 测试
```
