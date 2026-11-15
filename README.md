# Debezium 事务边界重组

面向 CDC 落地服务的零依赖 TypeScript 事务重组库。它消费 Debezium 数据事件和
transaction metadata，把跨 topic、跨分区的事件按 transaction id 聚合，并按
`total_order` / `data_collection_order` 生成不可分割的提交批次。

```ts
import { TransactionReassembler } from "./index.ts";

const reassembler = new TransactionReassembler();

// dataEvent 可以是 Debezium envelope、Kafka record 或带 schema 的 payload 包装。
const committed = reassembler.ingest(dataEvent);

for (const batch of committed) {
  // batch.events 已按 total_order 排序，且整个事务已通过完整性校验。
  await sink.commit(batch);
}
```

包同时提供已编译的 `index.js` / `index.d.ts`，因此可以直接从包根导入：

```ts
import { TransactionReassembler } from "dlks-de-0205";
```

## 输入

数据事件支持以下常见形态，transaction 信息可以位于 `transaction`、
`value.transaction`、`value.payload.transaction` 或直接平铺在记录上：

```json
{
  "topic": "server.inventory.customers",
  "partition": 3,
  "offset": 42,
  "transaction": {
    "id": "12345",
    "total_order": 2,
    "data_collection_order": 1
  },
  "value": { "op": "c", "after": { "id": 7 } }
}
```

事务边界事件（通常来自 `<topic.prefix>.transaction`）支持平铺、Kafka
key/value、`payload` 以及复合形式的输入：

```json
{ "status": "BEGIN", "id": "12345" }
{ "status": "END", "id": "12345", "event_count": 2,
  "data_collections": [{ "data_collection": "inventory.customers", "event_count": 2 }] }
```

`BEGIN`、`END`/`COMMIT`、`ABORT`/`ROLLBACK` 均可识别。也可以把边界事件作为
`ingest(dataEvent, metadataEvent)` 的第二个参数传入。

## 提交规则

- 只有收到 `END`、且 `total_order` 从序列起点到声明数量连续无缺口时才提交。
- `END.event_count` 是权威总数；`data_collections[].event_count` 同时校验每个
  data collection 的数量和 `data_collection_order` 连续性。
- 批次内事件按 `total_order` 升序排列；相同序号再按
  `data_collection_order`、topic、partition、offset 稳定排序。
- 同一 `total_order` 的重复事件必须深度相等，否则抛出
  `DuplicateEventConflictError`，该事务被标记为冲突且永不提交。
- 没有 transaction 信息的事件立即生成独立的非事务批次，不等待、不阻塞其他
  事务。
- 没有 `total_order` 的数据事件会进入缺口报告，阻止所属事务提交；补到缺失
  序号后可以正常提交。

## 超时与缺口

`checkTimeouts()` 只返回缺口描述，不删除缓冲、不拆分事件、不产生提交批次。

```ts
const gaps = reassembler.checkTimeouts(30_000);
// gaps[0].missingTotalOrders          => [2]
// gaps[0].missingDataCollectionOrders => { "inventory.customers": [2] }
// gaps[0].reason                      => "timeout"
```

超时后补齐缺失事件，事务仍可提交。`reportGaps()` 可随时查看所有未完成事务的
缺口。

## 崩溃恢复

`snapshot()` / `serialize()` 保存全部进行中状态和已发布事务 id。
`restore()` / `recover()` 会重新校验快照：只有完整事务会被发布，任何缺事件、
缺序号、冲突或只有 `BEGIN` 的事务都继续留在缓冲区。

```ts
const saved = reassembler.serialize();

const recovered = new TransactionReassembler();
const published = recovered.restore(saved); // 只包含完整事务
```

默认 `autoCommit: true`，完整事务会从 `ingest()` 的返回值交付。设置
`autoCommit: false` 后，完整事务保存在内部队列，通过 `drain()` / `flush()` /
`poll()` 交付；此时 `snapshot()` 仍会保留完整事务，恢复后只发布这些完整事务。

## 主要 API

`TransactionReassembler`（别名 `TransactionBuffer`、`TransactionAssembler`、
`DebeziumTransactionReassembler` 等）：

- `ingest(event, metadata?)` / `push` / `add` / `handle`：摄入一条事件，返回新
  交付的提交批次数组。数组上同时提供 `batches`、`committed`、`gaps` 等只读
  别名。
- `ingestMany(events)` / `pushMany`：批量摄入，支持 `[dataEvent, metadata]`
  二元组。
- `drain()` / `flush()` / `poll()`：交付 `autoCommit: false` 时排队完成的批次。
- `reportGaps()` / `getGaps()`：报告所有未完成事务的缺口。
- `checkTimeouts(timeoutMs?, now?)` / `timeout()`：只报告超时缺口。
- `snapshot()` / `serialize()` / `restore()` / `recover()`：可 JSON 持久化的
  崩溃恢复。
- `on("commit", fn)` / `on("gap", fn)` / `onCommit` / `onTimeout`：事件回调。

提交批次包含 `transactionId`、`events`、`eventCount`、`begin`、`end`、
`dataCollections`、`duplicateCount`，并保证 `complete: true`。

## 测试

```bash
npm test
```
