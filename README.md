# Change stream 恢复状态库

可导入的 TypeScript change stream 状态库，不依赖 MongoDB driver。它把原始
change event 组织成**可确认的输出批次**，并在批次确认后提交 resume token。

## 核心不变量

- **先确认，后提交**：`push()` 只产生批次，不会移动已提交游标；
  `acknowledge(batch)` 之后才可能提交 `batch.token`。
- **按顺序提交**：批次乱序确认时只提交连续已确认的前缀，不会跳过未确认批次。
- **事务原子输出**：同一 `lsid + txnNumber` 的事件进入同一个输出批次，批次
  确认后提交该事务最后一个事件令牌。
- **invalidate / history lost 开新世代**：清空活动游标，丢弃旧世代未确认批次，
  旧令牌只保留为历史证据，绝不作为新游标继续拼接。
- **rename 可追踪**：维护旧 namespace 到新 namespace 的映射，后续事件自动
  解析到有效 namespace。
- **lookup 双时点证据**：lookup 返回更新版本时，输出采用新文档，但事件时点、
  读取时点、事件时点文档和读取时点文档全部保留。

## 导入

```ts
import {
  ChangeStreamState,
  resolveFullDocument,
  isHistoryLostError,
} from "./index.ts";
```

包入口是 `index.ts`，也可使用 `ChangeStreamTracker`、
`ChangeStreamStateMachine` 或 `createChangeStreamState()` 别名。

## 批次确认

```ts
import { ChangeStreamState } from "./index.ts";

const state = new ChangeStreamState({ resumeToken: savedResumeToken });

for await (const event of changeStream) {
  for (const batch of state.push(event)) {
    await sink.write(batch.events); // 下游成功后才确认
    const result = state.acknowledge(batch);

    if (result.committedToken !== null) {
      await checkpoint.save(result.committedToken);
    }
  }
}

// 网络批次/空闲边界：关闭尚未输出的完整事务
for (const batch of state.flush()) {
  await sink.write(batch.events);
  state.acknowledge(batch);
}
```

`state.resumeToken` 始终是**活动世代已确认的游标**。在批次确认之前，
`state.pendingResumeToken` 可能已经包含新令牌，但它不会被暴露为可恢复游标。

主要输出结构：

```ts
interface OutputBatch {
  id: number;
  generation: number;
  kind: "events" | "transaction" | "control";
  status: "pending" | "acknowledged" | "committed" | "abandoned" | "rejected";
  events: OutputEvent[];
  token: unknown | null;
  transactionKey: string | null;
  control?: BatchControl;
}
```

## 事务批次

带 `txnNumber` 的事件会进入开放事务单元，直到：

- 调用 `flushTransaction(key)` 或 `flush()`；或
- 默认 `autoFlushTransactions: true` 时遇到非事务事件 / 另一个事务边界。

```ts
const state = new ChangeStreamState();

state.push({ _id: t1, operationType: "insert", lsid, txnNumber: 9, ... });
state.push({ _id: t2, operationType: "update", lsid, txnNumber: 9, ... });

const [transactionBatch] = state.flush();
// transactionBatch.kind === "transaction"
// transactionBatch.events.length === 2
// transactionBatch.token === t2，确认后才提交
```

`ingestMany(events)` 会自动在结尾 `flush()`，适合已经收集好一批事件的场景。

## invalidate 与 history lost

`invalidate` 事件会：

1. 将当前世代标记为关闭并放弃其未确认批次；
2. 创建 `status: "snapshot-required"` 的新快照世代；
3. 返回一个无令牌的 `control` 批次；
4. 使 `state.resumeToken === null`，旧令牌只出现在
   `state.previousResumeToken` / `state.lastEverCommittedToken`。

history lost 错误（MongoDB code `286`）走同样的世代切换：

```ts
try {
  // consume change stream
} catch (error) {
  const transition = state.handleError(error);
  if (transition) {
    const snapshot = await takeNewSnapshot();
    state.completeSnapshot({ resumeToken: snapshot.resumeToken });
  }
}
```

也可以显式调用：

```ts
state.invalidate(cause);
state.historyLost(error);
state.startSnapshotGeneration("manual");
state.beginSnapshot();
state.completeSnapshot({ resumeToken: snapshotToken });
```

新世代不会拼接旧游标。若调用方尚未显式完成快照，新世代事件仍可进入批次，
但其令牌只在新世代内提交。

## rename

`push()` 中的 `operationType: "rename"` 会自动更新映射：

```ts
state.push({
  _id: token,
  operationType: "rename",
  ns: { db: "app", coll: "users" },
  to: { db: "app", coll: "accounts" },
});

state.namespaceFor({ db: "app", coll: "users" });
// { db: "app", coll: "accounts" }
```

输出事件同时包含：

- `namespace`：解析后的有效 namespace；
- `previousNamespace`：事件原始 namespace（发生映射时）；
- `renamed`：rename 事件标记。

可链式 rename；`listRenameMappings()` 查看映射，`clearRenameMappings()` 清理。

## fullDocument lookup

`resolveFullDocument(event, lookup, options)` 在读取开始前记录 `readTime`，
并与事件 `clusterTime` 对比。lookup 来源支持：

- 异步函数 `(context) => document | null`；
- 带 `findOne(filter)` 的对象；
- 已取得的文档。

```ts
const evidence = await state.resolveFullDocument(event, (ctx) =>
  collection.findOne({ _id: ctx.documentKey?._id }),
);

if (evidence.newerThanEvent) {
  // 下游使用 evidence.document（读取时点版本）
  // 审计同时保留 evidence.preserved.event
  // 和 evidence.preserved.read
}
```

`FullDocumentLookupEvidence` 关键字段：

- `eventTime` / `eventTimeMs`：事件时点；
- `readTime` / `readTimeMs`：读取时点；
- `eventDocument` / `readDocument`：两个时点的文档；
- `eventVersion` / `readVersion`：版本证据；
- `newerThanEvent` / `lookupNewer`：lookup 是否看到更新版本；
- `versionComparison`：`newer | same | older | unknown`；
- `preserved.event` / `preserved.read`：完整双时点证据。

版本字段默认依次读取 `_version`、`version`、`rev`、`revision`、
`updatedAt`、`modifiedAt`、`clusterTime` 等，也可通过
`options.versionOf(document)` 自定义。

需要把 lookup 证据直接写入输出批次时：

```ts
const batches = await state.pushWithLookup(event, lookup, {
  versionOf: (doc) => doc.rev,
});
```

输出事件会带 `fullDocument`、`readTime`、`fullDocumentLookup` 和
`fullDocumentEvidence`。

## 常用 API

```ts
const state = new ChangeStreamState({
  resumeToken,
  clock: () => new Date(),
  autoFlushTransactions: true,
  idFactory: (generation) => `generation-${generation}`,
});

state.push(event);                  // -> OutputBatch[]
state.ingestMany(events);           // -> OutputBatch[]（自动 flush）
state.flush();                      // 关闭开放事务
state.acknowledge(batch);           // 确认输出批次
state.commitToken(token);           // 仅当承载 token 的批次已确认
state.reject(batch);                // 放弃批次，阻止后续连续提交

state.resumeToken;                  // 活动世代已提交 token
state.generation;                   // 当前世代号
state.currentGeneration;            // 世代快照
state.generations;                  // 历史世代
state.pendingBatches;               // 当前世代未提交批次

state.namespaceFor(ns);
state.listRenameMappings();
state.handleError(error);           // history lost -> 新世代
state.toJSON();                     // 便于持久化/观测
```

## 运行检查

```bash
npm test
npm run typecheck
```

测试脚本优先使用 Node 的 TypeScript strip-types；若当前 Node 构建不带该能力，
会通过 `tsc` 编译到临时目录后运行。
