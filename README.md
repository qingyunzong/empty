# GraphQL Relay 连接恢复

数据同步服务要可直接接入 TypeScript Relay connection 遍历库，联合 pageInfo、edge cursor 和节点版本推进。服务端插入或删除边时允许页面重叠，但 cursor 不前进、倒退或重复必须触发有界恢复；每条输出携带首次观察位置，取消后恢复不重放已确认批次。

## 模块

- `src/relay.ts` — Relay connection 类型（`Connection` / `Edge` / `PageInfo`）与 `FetchPage` 取页函数签名，可直接对接任何 Relay 遍历库。
- `src/cursor.ts` — 不透明 cursor 编解码（base64url JSON，含排序键 `key` 与存储代际 `gen`），`compareCursors` 提供游标先后比较。
- `src/sync-service.ts` — `SyncService`：按键排序的边存储，`upsert`/`delete` 推进存储代际与节点 `version`，`fetchConnection(after, first)` 返回标准 Relay connection；cursor 锚定排序键，服务端增删边不产生漏读。
- `src/sync-client.ts` — `SyncClient`：联合 `pageInfo.hasNextPage`/`endCursor`、edge cursor 与节点版本推进遍历。

## 行为约定

- 页面重叠被允许：客户端用有界窗口（`overlapWindow`）按 `node.id + version` 去重；版本推进的节点会重新下发，但保留首次观察位置。
- 每条输出 `SyncItem` 携带 `firstSeenAt`（首次观察到的页面位置，首页为 `@start`）。
- `pageInfo.endCursor` 不前进、倒退或重复时触发有界恢复：从最后确认位置重取，最多 `maxRecoveryAttempts` 次，耗尽后抛 `CursorViolationError`（`reason: 'not-advanced' | 'regressed'`）。
- 批次通过 `ack(batch)` 确认并写入 `CheckpointStore`；`cancel()` 后以同一 checkpoint 恢复时不重放已确认批次，未确认批次按至少一次语义重发。

## 用法

```ts
import { MemoryCheckpointStore, SyncClient, SyncService } from './index.ts';

const service = new SyncService<string>();
service.upsert('k00', 'value-0');

const checkpoint = new MemoryCheckpointStore();
const client = new SyncClient({
  fetchPage: async (after, first) => service.fetchConnection(after, first),
  checkpoint,
  pageSize: 100,
  batchSize: 100,
  maxRecoveryAttempts: 3,
});

for await (const batch of client.run()) {
  // 处理 batch.items（含 firstSeenAt / version / cursor）
  client.ack(batch);
}
```

## 脚本

- `npm test` — 编译到 `dist/` 并运行 `node --test`。
- `npm run typecheck` — 仅类型检查。
