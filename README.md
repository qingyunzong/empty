# GraphQL Subscription 连接状态与去重水位

可导入的 TypeScript 连接状态库，供订阅采集服务协调连接握手、订阅 id、
应用事件版本、keepalive 和下游确认水位。无运行时依赖。

## 快速使用

```ts
import { SubscriptionConnection } from "./index.ts";

const state = new SubscriptionConnection({
  initialWatermark: 0,
  watermarkMode: "contiguous",
  keepaliveTimeoutMs: 30_000,
});

const socket = state.connect("socket-1");

// 1. 握手：connection_ack 之前不接收业务事件
socket.handleMessage({ type: "connection_ack" });

// 2. 订阅：id 会绑定到当前 socket 代际
state.subscribe("orders-1", {
  payload: { query: "subscription { orders { id } }" },
});

// 3. 接收事件：payload 必须携带应用事件版本
const result = socket.handleMessage({
  type: "next",
  id: "orders-1",
  payload: { version: 1, data: { id: "o-1" } },
});

if (result.status === "accepted") {
  await persist(result.payload);
  // 4. 只有下游确认后才推进水位
  state.acknowledge({ version: 1, subscriptionId: "orders-1" });
} else if (result.status === "conflict") {
  // 同一版本、不同内容：记录冲突，交给复核流程处理
  console.error(result.existingContent, result.content);
}
```

重连时使用新的 socket 句柄；旧句柄上的迟到消息会被标记为
`stale-socket`，不会进入去重或业务处理。订阅可选自动恢复：

```ts
const reconnected = state.reconnect("socket-2", { resubscribe: true });
reconnected.handleMessage({ type: "connection_ack" });
```

也可以显式重订阅并保留原 stream / payload：

```ts
state.resubscribe("orders-2");
```

## 关键语义

- **握手门禁**：`connection_ack` 前到达的业务事件返回
  `ignored / not-acknowledged`。
- **订阅 id**：只接受当前代际中仍处于 `subscribed` 状态的 id；缺失 id 且
  只有一个活动订阅时自动关联。
- **代际隔离**：`connect` / `reconnect` 都会产生新的 `generation`。
  通过旧 `SocketSession` 送达的消息返回 `ignored / stale-socket` 并写入
  去重审计记录。
- **版本去重**：同一 stream 的同一版本：
  - 内容相同：`duplicate`，不重复投递；
  - 内容不同：`conflict`，保留原内容并记录双方内容哈希。
- **水位推进**：接收事件不改变水位，只有 `acknowledge/ack` 才推进。
  `contiguous` 模式要求确认连续（可自动锚定流的首个版本）；
  `max` 模式取已确认的最大版本。
- **keepalive**：`ka` / `ping` / `pong` / `heartbeat` 都会刷新活动时间；
  `checkKeepalive()` 返回是否超时。重连会重置 keepalive 计数。
- **审计**：`records`、`reconnectRecords`、`dedupeRecords` 均为可 JSON
  序列化副本；`exportAudit()` / `reviewAudit()` 用于落盘复核。

## 主要 API

| 方法 | 说明 |
| --- | --- |
| `connect(socketId?)` | 新建 socket 代际，返回 `SocketSession` |
| `reconnect(socketId?, options?)` | 重连并记录审计；`resubscribe` 可自动恢复订阅 |
| `handleConnectionAck(payload?)` | 处理 `connection_ack` |
| `subscribe(id, options?)` / `resubscribe(id?)` | 注册订阅并返回可发送的 subscribe 消息 |
| `handleMessage(message, session?)` | 统一分发协议消息 |
| `handleNext(payload, id?)` | 直接处理应用事件 |
| `acknowledge(versionOrEvent)` / `ack(version)` | 下游确认后推进水位 |
| `handleKeepalive()` / `checkKeepalive()` | 刷新或检查 keepalive |
| `snapshot()` / `exportAudit()` | 导出当前状态与审计记录 |

入口同时导出 `ConnectionState`、`ConnectionStateMachine`、
`SubscriptionState`、`createConnectionState()` 等别名，便于服务层迁移。

## 开发

```bash
npm test
npm run typecheck
```
