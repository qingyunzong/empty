# GraphQL 连接分页快照漂移

可导入的 TypeScript 连接分页库。它把一次完整遍历视为一个 **pass**，记录
`endCursor`、稳定节点键和服务端快照令牌；检测到页间插入、删除、快照变化或
游标失效时，按声明的能力重启，并按稳定键去重。同一键的不同内容会保留为连续
的修订世代。

## 快速开始

```ts
import { collectConnection } from "dlks-de-0211";

const result = await collectConnection({
  first: 100,
  nodeKey: "id",
  capabilities: {
    snapshotToken: true,
    requireSnapshotToken: true,
    insertStable: false,
    deleteStable: false,
    cursorCanInvalidate: true,
    restartable: true,
    maxRestarts: 3,
  },
  async fetchPage({ after, first, snapshotToken, pass, page, restart }) {
    const data = await client.query({
      query: CONNECTION_QUERY,
      variables: { after, first },
      context: { snapshotToken },
    });

    return {
      edges: data.connection.edges,
      pageInfo: {
        hasNextPage: data.connection.pageInfo.hasNextPage,
        startCursor: data.connection.pageInfo.startCursor,
        endCursor: data.connection.pageInfo.endCursor,
        totalCount: data.connection.totalCount,
      },
      snapshotToken: data.snapshot.token,
    };
  },
});

console.log(result.items);
console.log(result.receipt.coverage);
console.log(result.receipt.restarts);
```

`fetchPage` 还会收到 `pass`（从 1 开始的尝试轮次）、`page`（轮次内的页码）、
`restart`（是否为重启后的第一页）和 `signal`。首轮与每次重启的第一页都使用
`after: null` 和 `snapshotToken: null`（设置 `startAfter` 时从该游标开始）。

## 页面形状

标准 Relay `edges` 形状：

```ts
{
  edges: [{ cursor: "opaque-cursor", node: { id: "stable-key", ... } }],
  pageInfo: {
    hasNextPage: true,
    startCursor: "opaque-cursor",
    endCursor: "opaque-cursor",
    totalCount: 42
  },
  snapshotToken: "server-snapshot"
}
```

快照令牌也可放在 `pageInfo.snapshotToken`、`snapshot: "..."` 或
`snapshot: { token: "..." }`。若返回 `nodes` 而不是 `edges`，节点需自带
`cursor` 字段，或通过 `cursorOf(node, index)` 提供。

`nodeKey` 可传属性名、点路径或选择器 `(node, context) => string`。未提供时依次
尝试 `id`、`key`、`nodeId`、`uid`、`stableKey`；仍无键会抛出
`PaginationProtocolError`，不会用页内下标冒充稳定键。

## 一致性规则

每个 pass 只接受一条一致覆盖：

1. 第一页返回快照令牌后，后续请求都携带它；令牌变化、消失或晚出现都会记录为漂移。
2. `pageInfo.totalCount` 减少视为删除，增加视为插入。
3. 当前 pass 内同一稳定键以相同内容重复出现，视为页重叠/插入造成的位移。
4. `page.drift` 或 `page.changes` 可直接声明 `inserted`、`deleted`、
   `cursorInvalidated`。
5. GraphQL 错误码（如 `CURSOR_INVALID`、`CURSOR_EXPIRED`、`SNAPSHOT_EXPIRED`）
   或匹配的错误消息会触发游标失效处理；也可用 `isCursorInvalidation` 自定义识别。

检测到漂移后：

- `insertStable: true` 时，单纯的插入和页重叠可以继续，重复键只保留一次。
- `deleteStable: true` 时，单纯的删除可以继续。
- 快照令牌发生变化但无法判断具体变更类型时，只有同时声明插入和删除游标稳定才
  继续，否则重启。
- 否则在 `restartable: true` 下丢弃当前 pass，从 `after: null` 重跑。
- `maxRestarts` 用尽、`restartable: false` 或声明的能力被违反时抛出错误，不会
  返回伪成功的完成回执。
- 重启后的重复观测按稳定键去重；不同内容进入修订世代，不会覆盖历史。

默认能力是保守的：`insertStable` 和 `deleteStable` 都是 `false`，
`snapshotToken` 与 `restartable` 都是 `true`，`maxRestarts` 为 3。

## 修订世代

每个 `NodeRecord.revisions` 按观测到的不同内容递增：

```ts
const record = result.byKey.get("issue-42");
record?.revisions.map((revision) => ({
  generation: revision.generation,
  value: revision.node,
  cursor: revision.cursor,
  pass: revision.pass,
  snapshotToken: revision.snapshotToken,
}));
```

默认内容指纹是 `stableSerialize(node)`（对象键排序、确定性集合/Map 顺序）。如果
服务端提供版本号或 ETag，建议用 `fingerprint(node) => revision` 避免对完整节点
做序列化。

如果同一键在同一个 pass 内出现不同内容，库会记录 `same-key-revision` 漂移、
保留全部世代，但不自动重启以避免持续修订造成无限重试；该 pass 的一致性证明会
相应降级，并在 `warnings` 中说明。

`result.items` 是最终通过 pass 中的最新观测，顺序与最终 pass 一致；
`result.records` / `result.byKey` 保留所有 pass 的全部观测。只出现在被放弃 pass
中的键会列在 `receipt.observedOnlyBeforeRestart` 中，不会被静默丢弃。

## 完成回执

```ts
{
  complete: true,
  consistency: "snapshot-token" | "declared-stable" | "unverified",
  warnings: [],
  coverage: {
    after: null,
    startCursor: "cursor-1",
    endCursor: "cursor-200",
    startKey: "issue-1",
    endKey: "issue-200",
    pageCount: 4,
    edgeCount: 200,
    nodeCount: 198
  },
  finalPass: {
    pass: 2,
    pages: 4,
    snapshotToken: "snapshot-7",
    pinnedSnapshotToken: true,
    // ...
  },
  restartCount: 1,
  restarts: [{
    reason: "snapshot-token-changed",
    detectedBy: "snapshot-token",
    pass: 1,
    page: 2,
    requestAfter: "cursor-50",
    snapshotTokenBefore: "snapshot-6",
    snapshotTokenObserved: "snapshot-7",
    observedKeys: ["issue-1", "..."],
    // ...
  }],
  drifts: [/* 包括可安全继续的漂移 */],
  duplicateSightings: 50,
  revisionCount: 2,
  observedOnlyBeforeRestart: [],
  snapshotTokens: ["snapshot-6", "snapshot-7"],
  // ...
}
```

`coverage` 描述最终通过 pass 的闭区间；`restarts` 是实际执行的重启及其当时的
游标、令牌、计数和已观测键；`drifts` 还包含声明能力允许安全继续的漂移。

`consistency` 说明覆盖证明强度：

- `snapshot-token`：令牌从第一页起固定且未变化。
- `declared-stable`：没有从第一页固定令牌，或固定令牌期间发生了可继续的漂移，
  但服务端声明插入和删除游标都稳定。
- `unverified`：完整遍历已结束，但没有从第一页固定令牌；或中途发生了被继续的
  漂移（包括 `same-key-revision`）。此时 `warnings` 会明确说明，调用方不应把
  回执当作强一致快照。

如果没有快照令牌、`totalCount` 或漂移提示，删除本身是不可观测的；库不会声称
检测到了它，而会用 `unverified` 明确暴露证明缺口。需要强一致时，应提供快照令
牌，或保证服务端真正支持稳定的键集游标。

## 增量检查点

`onPage` 在每页处理后触发，并携带当前 pass 的 `checkpoint`：

```ts
await collectConnection({
  // ...
  onPage(event) {
    persist({
      pass: event.pass,
      page: event.page,
      endCursor: event.checkpoint.endCursor,
      snapshotToken: event.checkpoint.snapshotToken,
      keys: event.checkpoint.keys,
      complete: event.checkpoint.complete,
      willRestart: event.willRestart,
    });
  },
  onRestart(evidence) {
    audit(evidence.reason, evidence.observedKeys);
  },
});
```

最终 `result.checkpoint.complete` 为 `true`；若一页触发了重启，该页事件的
`willRestart` 为 `true`，此时保存的是被放弃 pass 的位置，不应作为续采依据。

## 导出

- `collectConnection` / `paginateConnection` / `paginate` / `collect` /
  `paginateGraphQLConnection` / `collectGraphQLConnection`
- `ConnectionPaginator`
- `stableSerialize`
- `isCursorInvalidationError`
- `CursorInvalidationError`
- `PaginationDriftError`、`PaginationCapabilityError`、
  `PaginationRestartLimitError`、`PaginationProtocolError`

## 开发

```bash
npm test        # 构建 dist 并运行行为测试
npm run typecheck
```
