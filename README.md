# WebSocket 增量快照重连

`SnapshotIncrementalCoordinator` 用于把行情频道的增量消息与 REST/WS 快照拼接成一致订单簿。行情采集器可以直接把 WebSocket 消息交给协调器，由它负责 sequence 校验、gap 检测、重连缓存和有界重放。

## 核心保证

- 只有从快照基线开始、sequence 完全连续的订单簿才会通过 `onBook` 发布。
- `snapshot.sequence` 表示快照已经包含的最后一个频道 sequence，下一条应处理 `snapshot.sequence + 1`。
- 重复或过期的增量（`sequence <= lastSequence`）会被幂等忽略。
- 等待快照期间最多缓存 `maxBufferedDeltas` 条增量，并且同一 sequence 只保留一次。
- 快照到达后丢弃 `sequence <= snapshot.sequence` 的缓存，只重放紧随其后的连续序列。
- 发现 gap、快照过期或缓存溢出时，通过 `requestSnapshot` 重新请求快照；在重新同步完成前不会发布跨越 gap 的部分订单簿。
- 每个频道独立维护状态，互不影响。

## 快速接入

```ts
import { SnapshotIncrementalCoordinator } from "./index.ts";

const coordinator = new SnapshotIncrementalCoordinator({
  maxBufferedDeltas: 1024,
  requestSnapshot: async ({ channel, reason }) => {
    const snapshot = await fetchSnapshot(channel);
    coordinator.handleSnapshot(snapshot);
    console.log("snapshot requested", channel, reason);
  },
  onBook: (book) => {
    // book.sequence 以内无缺口，可以安全消费/发布
    publish(book);
  },
  onError: (error) => console.error(error.code, error.message),
});

socket.on("open", () => {
  // 重连后等待新快照，期间到达的增量进入有界缓存
  coordinator.beginReconnect("BTC-USD");
});

socket.on("message", (raw) => {
  coordinator.handleMessage(JSON.parse(raw));
});
```

输入消息格式：

```ts
// 快照
{
  type: "snapshot",
  channel: "BTC-USD",
  sequence: 100,
  bids: [[100.5, 2], [100.4, "1.5"]],
  asks: [{ price: 100.6, size: 1 }],
}

// 增量；size 为 0 表示删除该价位
{
  type: "delta", // 也接受 "update" / "increment"
  channel: "BTC-USD",
  sequence: 101,
  bids: [[100.5, 0]],
  asks: [[100.6, 3]],
}
```

价格和数量支持 `number` 或数字字符串，输出统一为 `number`。买盘按价格降序、卖盘按价格升序发布。

## 状态与 API

- `handleMessage(message)`：按 `type` 分发快照或增量。
- `handleSnapshot(snapshot)` / `handleDelta(delta)`：直接处理无标签消息。
- `beginReconnect(channel?)`：标记重连并请求快照；省略频道时处理所有已知频道。
- `resync(channel, reason?)`：手动失效频道并请求快照。
- `getState(channel)`：查看 `phase`、`lastSequence`、`snapshotSequence`、缓存条数等。
- `getBook(channel)`：返回最近一份连续订单簿的防御性副本。
- `isSynchronized(channel)`：仅当频道处于 `live` 时返回 `true`。
- `reset(channel?)`：丢弃频道状态。

`getState(channel).phase` 有两种状态：

- `awaiting-snapshot`：尚未拿到可用快照，或检测到 gap/溢出，增量只缓存不发布。
- `live`：已从快照基线连续应用到 `lastSequence`，可以逐条发布。

## 校验

```bash
npm test
npm run typecheck
```
