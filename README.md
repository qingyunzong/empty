# 模型服务批处理调度器

可嵌入的 TypeScript 批处理组件。请求按模型版本和输入形状隔离，并在以下任一条件出现时发出：

- 达到 `maxBatchSize`。
- 队首请求等待达到 `maxWaitMs`。
- 批次中最早的绝对截止时间 `deadline` 到达。

同一批次只包含模型版本、输入形状完全一致的请求。不同截止时间的请求可以合并，但批次始终以最早截止时间发出，因此不会让任何请求等到自己的截止时间之后。截止时间边界按“小于等于截止时间”处理。已经过期的请求不会进入批次，而是以 `RequestTimeoutError` 明确失败。

## 使用

```ts
import {
  BatchScheduler,
  VirtualClock,
} from "./index.ts";

const clock = new VirtualClock(0);
const scheduler = new BatchScheduler({
  clock,
  maxBatchSize: 8,
  maxWaitMs: 25,
  defaultModelVersion: "2026-11",
  handler: async (batch) => {
    const outputs = await modelServer.run({
      version: batch.modelVersion,
      shape: batch.inputShape,
      inputs: batch.requests.map((request) => request.payload),
    });
    return outputs; // 与 batch.requests 顺序对应的数组
  },
});

const result = scheduler.submit({
  id: "req-1",
  inputShape: [1, 224, 224, 3],
  deadline: 1_000, // 调度器时钟上的绝对时间
  payload: tensor,
});
```

`handler` 可以返回单个结果（广播给批次内所有请求）、与请求顺序一致的数组，或以请求 id 为键的 `Map`。省略 `handler` 时，调度仍会正常发生，请求结果为 `undefined`。

## 取消与版本切换

- `scheduler.cancel(id)` 只能取消尚未发出的请求，返回 `false` 表示请求不存在或已经进入批次。
- `submit({ signal })` 在请求发出前触发 `AbortSignal` 时同样会释放批次名额。
- 已取消请求既不计数、也不进入后续批次，等待窗口从剩余队首请求重新计算。
- `switchVersion(version)` 会先封存并发出所有已排队的旧版本队列；已进入处理器的旧批次继续完成。
- 切换后的新请求不会加入旧队列。省略 `modelVersion` 时使用当前活动版本；传入 `{ rejectRetiredVersions: true }` 可让显式指定旧版本的后续提交失败。
- `flush()` 可立即发出所有待处理队列，`drain()` 会发出剩余队列并等待所有处理器完成。

## 虚拟时钟验证

`VirtualClock` 按时间顺序执行到期定时器，同一时刻按注册顺序执行：

```ts
const clock = new VirtualClock(100);
clock.advanceBy(25);
clock.advanceTo(200);
```

测试覆盖：

- 版本与输入形状隔离，最大批量立即触发。
- 等待上限、较早截止时间以及截止时间边界。
- 已过期请求明确超时，不会被发送。
- `cancel()` 和 `AbortSignal` 释放名额。
- 版本切换期间旧批完成、新旧批次不混合。
- 160 轮确定性虚拟时钟压力场景，校验所有已发出批次兼容，且每个成功请求都在截止时间前或截止时间当刻发出。

运行：

```bash
npm test
npm run typecheck
```
