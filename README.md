# stream-watermark-sim

流模拟库：以**活跃分区的最小水位**作为全局水位，空闲分区暂时排除；恢复数据若早于已公布水位则必须拒绝。空闲完全由显式事件声明，不猜测墙钟。

## 事件模型

```ts
type StreamEvent =
  | { type: 'data'; partition: string; timestamp: number } // 数据事件，推进分区水位
  | { type: 'idle'; partition: string }                    // 显式声明空闲
  | { type: 'active'; partition: string };                 // 显式恢复
```

## 语义

- 全局水位 = 所有**活跃**且已上报数据的分区的水位最小值；空闲分区不参与。
- 只有候选水位**超过**已公布水位时才发布新轨迹点，轨迹严格递增（单调性由构造保证）。
- `data` 事件到达空闲分区会使其重新激活（真实数据意味着活跃），但同样受拒绝规则约束。
- 尚未上报过数据的分区不参与最小值计算。

## 拒绝规则（记录于 `rejections`，绝不静默丢弃）

| reason | 触发条件 |
| --- | --- |
| `late-data-below-partition-watermark` | 数据时间戳低于本分区当前水位 |
| `data-before-published-watermark` | 数据时间戳早于已公布的全局水位 |
| `recovery-behind-published-watermark` | `active` 恢复时分区水位落后于已公布水位，分区保持空闲 |

## 输出

`replay(events)` 返回：

- `trajectory`: 全局水位轨迹（每次发布的 `{ sequence, watermark, cause }`）
- `rejections`: 拒绝记录（事件序号、原因、当时已公布水位）
- `finalWatermark`: 最终全局水位
- `partitions`: 各分区终态
- `monotonic`: 重放核验结果，轨迹是否严格递增

## 用法

```ts
import { replay } from 'stream-watermark-sim';

const result = replay([
  { type: 'data', partition: 'p2', timestamp: 5 },
  { type: 'data', partition: 'p1', timestamp: 10 },
  { type: 'idle', partition: 'p2' },        // p2 空闲，排除出最小值计算
  { type: 'data', partition: 'p1', timestamp: 20 },
  { type: 'active', partition: 'p2' },      // p2 水位 5 < 已公布 20 → 拒绝
  { type: 'data', partition: 'p2', timestamp: 25 }, // 追上后重新加入
]);
// result.trajectory → 水位 5, 10, 20
// result.rejections → 1 条 recovery-behind-published-watermark
// result.monotonic  → true
```

## 测试

```sh
npm test   # tsc 编译后运行 node:test 测试（无需 npm install，使用全局 tsc）
```
