# interval-join-stream

流式区间连接库：连接两路半开时间区间事件流，输出全部非空交集及来源 ID，
并用水位（watermark）驱动状态回收、迟到拒绝与驻留限额背压。

## 语义

- 每个事件携带半开区间 `[start, end)`；两侧区间重叠即连接，输出
  `{ leftId, rightId, start, end }`，其中 `[start, end)` 为交集。
  端点相接（如 `[0,2)` 与 `[2,4)`）不算重叠。
- 水位 `W` 表示"不会再有 `start < W` 的事件到来"。
- **回收**：水位推进到 `W` 时，所有 `end <= W` 的驻留项不可能再匹配任何
  未来事件，被安全回收。
- **迟到**：`start < 当前水位` 的事件被拒绝（`status: "late"`）。
- **背压**：驻留项总数达到 `maxBuffered` 时，新事件被拒绝
  （`status: "backpressure"`），调用方应在水位推进释放空间后重试。
- 乱序事件允许：只要不越过水位，乱序到达的事件照常与驻留项配对。

## API

```ts
import { IntervalJoin, offlineJoin } from "./src/interval-join.js";

const join = new IntervalJoin({ maxBuffered: 1000 });

const out = join.pushLeft({ id: "L1", start: 0, end: 10 });
// out.status: "ok" | "late" | "invalid" | "backpressure"
// out.emitted: JoinResult[] —— 本次新产生的交集

join.pushRight({ id: "R1", start: 5, end: 15 });
// -> emitted: [{ leftId: "L1", rightId: "R1", start: 5, end: 10 }]

join.advanceWatermark(10); // 回收 end <= 10 的驻留项，返回回收数量
join.bufferedCount;        // 当前驻留项数
join.reclaimedCount;       // 累计回收数

offlineJoin(leftEvents, rightEvents); // 离线全配对参考实现
```

## 测试

```sh
npm test
```

测试先用 `tsc` 编译到 `dist/`，再用 Node 内置测试运行器执行。覆盖：
基本交集与半开边界、乱序配对、水位回收精确性、迟到拒绝（含边界）、
背压与重试、非法事件拒绝，以及随机化属性测试——在乱序、水位推进与
背压重试下，流式输出与离线全配对参考（`offlineJoin`）逐一比对一致。
