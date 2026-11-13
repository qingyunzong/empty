# NATS JetStream 序列缺口修复

`JetStreamArchiver` 是一个无 NATS 依赖的消费状态协调器。它直接接收
TypeScript JetStream 客户端消息（`msg.seq`、`deliverySeq` /
`info.deliverySequence` 等），按 **stream sequence** 有序发布归档记录，同时
独立维护 **consumer sequence**。

## 行为

- `stream sequence` 决定归档顺序、缺口检测和提交游标。
- `consumer sequence` 只用于消费进度、重投递识别和诊断，不与 stream 序混用。
- 相同 stream sequence 的重投递不会重复发布；consumer sequence 仍会推进。
- flow control、heartbeat 等控制帧不会推进任何消息游标。
- 收到的 stream sequence 大于下一个期望值时，立即暂停发布/提交，并只对该缺口
  发起一次范围补取请求。
- 补取结果和实时消息进入同一个按 stream sequence 排序的缓冲区；补取完成后仍按
  stream 序发布。
- 补取确认完整但缺失的 sequence，以及显式传入的 `deleted` / `holes`，都会生成
  `PermanentHole`；只有永久空洞被记录后，提交游标才会越过它。

## 接入

```ts
import { JetStreamArchiver } from "./index.js";

const archiver = new JetStreamArchiver<Uint8Array>({
  // 从上次快照的 snapshot().stream.nextSeq 恢复
  startStreamSeq: 1,
  startConsumerSeq: 0,

  publish: (record) => {
    // record.streamSeq / record.streamSequence
    // record.consumerSeq / record.consumerSequence（补取记录可能没有）
    archiveWriter.append(record);
  },

  requestBackfill: async (request) => {
    // request.range 为闭区间 [start, end]；每个缺口只调用一次
    const messages = await fetchStreamRange(request.range);
    archiver.handleBackfill({
      requestId: request.id,
      messages,
      complete: true,
    });
  },

  onCommit: (commit) => {
    checkpoint.save(commit.streamSeq, commit.consumerSeq);
  },

  onPermanentHole: (hole) => {
    auditLog.write(hole);
  },
});

consumerState.onMessage((msg) => archiver.ingest(msg));
consumerState.onFlowControl((payload) =>
  archiver.handleFlowControl(payload),
);
consumerState.onHeartbeat(() => archiver.handleHeartbeat());
```

如果消费状态组件把所有帧交给同一回调，可直接使用：

```ts
const handlers = createConsumerStateHandlers(archiver);

consumerState.onMessage(handlers.message);
consumerState.onRedelivery(handlers.redelivery);
consumerState.onControl((subject, data) =>
  archiver.handleControlMessage(subject, data),
);
consumerState.onBackfill(handlers.backfill);
```

## 回填与删除

`handleBackfill` 的默认 `complete` 为 `true`：调用方必须只在已扫描完整
`range` 后使用默认值。范围内的缺失 sequence 会被记录为永久空洞。分段回填时
传入 `complete: false`，待所有分段到齐后再传最后一次 `complete: true`。

```ts
archiver.handleBackfill({
  requestId: request.id,
  messages: foundMessages,
  deleted: [{ start: 12, end: 14 }],
  holeReason: "retention",
  complete: true,
});
```

也可以直接记录 direct-get 的永久 404：

```ts
archiver.markPermanentHole(42, "not-found");
```

## 状态

`snapshot()` 返回可直接持久化或用于监控的状态：

```ts
const state = archiver.snapshot();

state.stream.committedSeq;   // stream 提交游标
state.stream.nextSeq;        // 恢复时的 startStreamSeq
state.stream.commitPaused;   // 缺口未闭合时为 true
state.consumer.committedSeq; // consumer 提交游标
state.backfill.requests;     // 每个缺口的单次范围请求
state.permanentHoles;        // 已确认的永久空洞
```

## 验证

```bash
npm test
npm run typecheck
```
