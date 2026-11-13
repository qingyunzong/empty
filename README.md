# Event Hubs epoch 所有权

遥测采集器可直接接入的 TypeScript 分区所有权组件。它把 epoch receiver、
ownership ETag 与 checkpoint 放在同一条提交路径上，并提供可控内存存储用于
枚举两工作者竞争。

## 核心行为

- `acquire()` 占用空闲分区；`acquire({ preempt: true })` 或过期租约上的新
  claim 会生成下一个 epoch 和新的 ownership ETag。
- 每次 checkpoint 提交同时校验分区、epoch、worker 和 ownership ETag；旧
  epoch 的在途批次会以 `PreemptedError` 拒绝，不会推进水位。
- `renew()` 失败后 `leaseLost` 立即为真。当前批次仍可执行 handler 到批边界，
  但 `commit()` 抛出 `LeaseLostError`，水位保持最后一次成功 checkpoint。
- checkpoint 自身也使用 ETag CAS，并拒绝水位回退。
- `ControllablePartitionStore` 可注入下一次操作失败、持久失败或暂停指定操作，
  测试可用它确定性地枚举两个工作者的 claim / renew / commit 顺序。

## 用法

```ts
import {
  ControllablePartitionStore,
  ManualClock,
  PartitionOwnership,
  TelemetryCollector,
} from "./index.ts";

const clock = new ManualClock(1_000);
const store = new ControllablePartitionStore({ now: clock.now });
const ownership = new PartitionOwnership({
  store,
  workerId: "worker-a",
  partitionId: "orders-0",
  leaseDurationMs: 30_000,
  now: clock.now,
});

await ownership.acquire();
const receiver = ownership.createEpochReceiver({
  batches: [{ sequenceNumber: 100, events: [] }],
});

const collector = new TelemetryCollector({
  ownership,
  receiver,
  autoRenew: true,
  process: async () => {
    // 写入下游遥测管道；提交失败时下游需按 at-least-once 处理。
  },
});

await collector.run();
```

竞争测试见 `test/ownership.test.ts`：覆盖空闲分区双 claim、过期租约
renew/takeover 两种顺序、抢占期间旧 epoch 提交、续租失败批边界和 checkpoint
CAS。

## 命令

- `npm test`：运行行为测试（无原生 TypeScript 运行时的 Node 会先用 `tsc`
  编译到 `TMPDIR`）。
- `npm run typecheck`：严格类型检查。
