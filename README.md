# 批 API 子请求状态库

用于批量采集连接器的可导入 TypeScript 状态库。它把一批乱序返回的子请求结果，按
`clientItemId` 精确配对为成功、可重试、永久失败、缺失和隔离状态，并生成重试批次。

## 使用

```ts
import {
  SubRequestBatchState,
  reconcileBatchResponse,
} from "./index.ts";

const requests = [
  { clientItemId: "row-1", idempotencyKey: "idem-1", payload: { id: 1 } },
  { clientItemId: "row-2", idempotencyKey: "idem-2", payload: { id: 2 } },
  { clientItemId: "row-3", idempotencyKey: "idem-3", payload: { id: 3 } },
];

const state = new SubRequestBatchState(requests);
state.applyResponse({
  results: [
    { clientItemId: "row-3", status: "success", value: { stored: true } },
    { clientItemId: "row-1", status: "retryable", error: { code: "BUSY" } },
  ],
});

const snapshot = state.snapshot();
snapshot.success; // row-3，按 id 配对，不按响应下标配对
snapshot.retryable; // row-1
snapshot.missing; // row-2
snapshot.retryBatch; // [row-1]，只含可重试项，幂等键保持不变
```

一次性处理后直接取分组结果：

```ts
const result = reconcileBatchResponse(requests, {
  timedOut: true,
  results: [
    { clientItemId: "row-2", status: "success", value: 2 },
  ],
});

result.success; // row-2 保持成功，超时不会覆盖已确认结果
result.retryable; // row-1、row-3
result.retryBatch; // 只包含 row-1、row-3，各自保留原 idempotencyKey
```

## 状态规则

- 只按 `clientItemId` 做严格、区分大小写的配对；未知 id 进入 `unknownResults`，不会占用其他请求的位置。
- 同一 id 的重复结果内容一致时去重；状态、结果值或错误内容冲突时整体进入 `quarantined`，不成功、不重试。
- 响应中的 `idempotencyKey` 若存在且与原请求不一致，也进入隔离，避免错配重试。
- 响应中缺少某请求的结果时标记为 `missing`；显式 `missing` 结果同样处理。
- 批级超时只把仍为 `missing`/`pending` 的项提升为可重试，已确认的 `success`、`failed` 和 `quarantined` 不变。
- 超时后迟到的结果会替换临时的 `retryable` 状态，因此成功仍可被确认。
- `getRetryBatch()` 默认只重组 `retryable` 项；传 `{ includeMissing: true }` 或 `{ includeUnresolved: true }` 可把缺失/未决项一并加入重试，`pending` 也可用 `{ includePending: true }` 加入。
- 重试项是原请求的副本，`clientItemId`、`idempotencyKey` 和自定义字段均原样保留。

## API

- `new SubRequestBatchState(requests, { finalizeMissing })`：有状态跟踪器；`finalizeMissing` 默认 `true`。
- `applyResponse(response, options)` / `apply` / `recordResults`：应用数组或 `{ results | items | subRequestResults, timedOut }` 响应；`options` 支持 `finalizeMissing`、`timedOut`、`batchTimedOut`。
- `markTimedOut()` / `timeout()`：标记批级超时。
- `finalize()` / `complete()`：把仍未决项标记为缺失。
- `snapshot(options)`：返回 `items`、`byClientItemId`、各状态分组、计数、未知结果及 `retryBatch`。
- `getRetryBatch(options)` / `createRetryBatch`：返回数组形式的 `RetryBatch`，并附带 `items`、`requests`、`clientItemIds`、`reasons`。
- `reconcileBatchResponse(requests, response, options)`：一次性完成配对、分组和重试批次构建；别名包括 `splitBatchResponse`、`applyBatchResponse`。
- `buildRetryBatch(state | requests, response?, options?)`：从跟踪器或原始请求与响应构建重试批次。

响应项状态支持 `success`/`succeeded`/`ok`、`retryable`/`transient`、`failed`/`permanent_failure`、
`missing` 等写法，也支持 `ok`、`retryable`、`missing` 布尔字段或无状态时按 `value`/`error` 推断。

## 验证

```sh
npm test
npm run typecheck
```
