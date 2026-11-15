# Pulsar 游标回退与批消息确认

零依赖的 TypeScript Pulsar 游标组件，可从 `index.ts`（或 `pulsar-cursor.ts`、`cursor.ts`）导入。正常确认时持久游标只向前推进，否认或显式回退时才向后回卷；未完成位置作为可核对的 `from`/`to` 闭区间返回。

```ts
import { PulsarCursor } from "./index.ts";

const cursor = new PulsarCursor({
  onPersist: (position) => console.log("durable cursor", position),
});

// ledger 1 / entry 8 / batchIndex 2，batchSize 为 4
const message = {
  ledgerId: 1n,
  entryId: 8n,
  batchIndex: 2,
  batchSize: 4,
};

cursor.observe(message);                 // 返回带 delivery token 的投递信息
cursor.acknowledgeCumulative({
  ledgerId: 1n,
  entryId: 8n,
  batchIndex: 1,
  batchSize: 4,
});

cursor.pending;                          // { from: 8:2, to: 8:3 }
cursor.acknowledge(message);
cursor.acknowledge({ ledgerId: 1n, entryId: 8n, batchIndex: 3, batchSize: 4 });
cursor.cursor;                           // { ledgerId: 1n, entryId: 8n, batchIndex: 3 }
```

## 语义

- 位置按 `(ledgerId, entryId, batchIndex)` 排序；非批消息使用 `batchIndex === -1`。
- `acknowledge`/`ack` 单条确认，`acknowledgeCumulative` 累积确认，`negativeAcknowledge`/`nack` 单条否认。
- 批消息只有 `0..batchSize-1` 全部进入终态（确认或截断）后，持久游标才越过该 entry。批内只确认一部分时，游标停在 entry 之前，未决区间从第一个未决子项开始。
- 未提供 `batchSize` 时可用 `registerBatch(id, size)` / `sealBatch(id, size)` 明确批次边界。只观察到 `batchIndex` 无法推导批次总长度，组件不会猜测。
- `negativeAcknowledge` 会把持久游标回退到受影响 entry 之前，并把该子项重新暴露在未决区间中。
- `rollback(id)` 回到 `id`（包含）重新消费；`rollback(id, { inclusive: false })` 从 `id` 之后开始。回退会提升 generation，并重开 `id` 之后的子项。
- `observe` 返回 `token`。重投或回退后，用旧 token 确认会被标记为 `stale` 并忽略，避免旧世代确认误推到新世代消息；用新 token（或不带 token）确认新投递。
- `truncate(id)` 处理 topic 截断（默认删除到 `id` 为止，包含）；`truncateBefore(id)` 表示只删除 `id` 之前的消息。被截断的位置从游标和未决区间中移除。

## 结果与快照

`ack`、`nack`、`rollback`、`truncate` 均返回统一的 `CursorUpdate`：

```ts
{
  accepted: boolean,
  changed: boolean,
  advanced: boolean,
  stale: boolean,
  generation: number,
  cursor: MessageId | null,
  pending: { from: MessageId, to: MessageId } | null,
  acknowledged: MessageId[],
}
```

`pending.from`/`pending.to` 是包含端点的闭区间；同一对象上还提供 `start`、`end`、`positions` 等只读别名。需要精确子项列表时可调用 `pendingMessages()`，需要拆分多个连续区间时可调用 `pendingRanges()`。

`snapshot()`/`serialize()` 保存游标、累积确认水位、截断水位、批次子项状态和 generation；`PulsarCursor.deserialize(value)` 或 `restore(value)` 可恢复。`onPersist`/`persist`/`store.save` 只在持久游标真正前进或回退时触发，批内部分确认不会触发。

## 类型检查与测试

```bash
tsc --noEmit -p tsconfig.json
```

`test/cursor.test.ts` 覆盖累积确认、批内部分确认、未决区间、否认回退、重投 token、topic 截断和快照恢复。
