# OData deltaLink 墓碑合并

可导入的 TypeScript OData delta 同步组件。它消费 `@odata.nextLink`、`@odata.deltaLink`、实体更新和 `@removed` 墓碑，支持分页中断续跑、整轮原子提交，以及按服务端版本裁决实体重建和迟到墓碑。

## 快速开始

```ts
import {
  DeltaSyncError,
  MemoryDeltaStore,
  ODataDeltaSync,
} from "./index.js";

interface Customer {
  "@odata.id": string;
  version: number;
  Name?: string;
}

const store = new MemoryDeltaStore<Customer>();
const sync = new ODataDeltaSync<Customer>({
  resource: "Customers",
  store,
  initialLink: "https://api.example.test/odata/Customers?$deltatoken=0",
  fetchPage: async (url) => {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.TOKEN}` },
    });
    if (!response.ok) {
      throw new Error(`OData request failed: ${response.status}`);
    }
    return response.json();
  },
});

try {
  const result = await sync.sync();
  console.log(result.deltaLink, result.stats);
} catch (error) {
  if (error instanceof DeltaSyncError && error.resumable) {
    // 同一实例重试会从失败的 nextLink（或提交阶段）继续。
    const result = await sync.sync();
  } else {
    throw error;
  }
}
```

`fetchPage` 也可以直接返回已解析的 JSON 对象，或返回带有 `json()`、`ok`、`status` 的 Response-like 对象。组件把服务端返回的 link 原样传给 `fetchPage`；如果服务返回相对 URL，请在这里按服务根地址解析。

## 行为约定

### 分页与 deltaLink

- 只要响应包含 `@odata.nextLink`，组件就继续沿该链接读取；中间页即使带有 `@odata.deltaLink` 也不会生效。
- 最后一个既没有 `nextLink` 的页面必须提供 `@odata.deltaLink`，否则整轮失败且不落库。
- 整轮的实体变更先缓冲在内存中。只有完整读取整条分页链后，才调用一次 `store.commit(changes, cursor)`。
- 新 `deltaLink` 只随这次提交一起生效，不会在分页途中写到游标。

### 分页失败后的恢复

- 同一实例调用 `sync()` 重试时，会从失败页的 `nextLink` 继续，已经读取的页面不会重放。
- 提交阶段失败时，重试只重新提交，不会重新抓取分页。
- 需要跨进程恢复时，把 `sync.checkpoint` 序列化保存，再在新实例上 `resume(checkpoint)`。检查点只包含原链位置和缓冲变更，不包含已生效的新 `deltaLink`。
- 没有检查点时，从上一个已提交的 `deltaLink` 重新开始也是安全的，因为整轮没有部分落库。
- 提交带有 `expectedBaseDeltaLink` 乐观校验。如果另一写入方已推进游标，恢复或提交会以 `CURSOR_CONFLICT` 拒绝，避免旧链覆盖更晚的游标；此时应丢弃旧检查点并从最新游标重新同步。

```ts
const checkpoint = sync.checkpoint; // 可 JSON.stringify 持久化

const restored = new ODataDeltaSync<Customer>(options);
restored.resume(JSON.parse(JSON.stringify(checkpoint)));
const result = await restored.sync();
```

### 原子落库

`DeltaStore.commit` 必须在一个数据库事务内同时完成实体变更和游标更新；失败时两者都不得变化。组件只会调用这一个写入入口。

```ts
interface DeltaStore<T> {
  getCursor(resource: string): DeltaCursor | undefined | Promise<...>;
  commit(
    resource: string,
    changes: readonly DeltaChange<T>[],
    cursor: DeltaCursor,
  ): CommitStats | void | Promise<...>;
}
```

存储需要保留墓碑版本（或等价的删除版本水位）。否则，删除后的迟到更新无法被正确拒绝。

`commit` 还会收到 `CommitOptions.expectedBaseDeltaLink`。自定义存储应在同一事务中校验当前游标：不匹配时抛出 `CURSOR_CONFLICT`，避免两个同步器基于同一旧链并发提交时发生游标回退。`compareVersions` 也会随提交传入，供存储执行与同步器一致的版本裁决。

`MemoryDeltaStore` 是参考实现：它先在副本上应用整批变更，成功后用一次状态替换同时公开记录和游标，因此中途异常不会留下部分结果。

自定义事务存储可以在事务内复用 `reconcileChange`：

```ts
import {
  reconcileChange,
  type CommitStats,
  type DeltaStore,
} from "./index.js";

// db/tx 是项目自己的数据库抽象；transaction 必须保证原子性。
const commitDeltaRound: DeltaStore<Customer>["commit"] = (
  resource,
  changes,
  cursor,
  options,
) =>
  db.transaction(async (tx) => {
    const stats = {
      received: changes.length,
      applied: 0,
      ignored: 0,
      inserted: 0,
      updated: 0,
      removed: 0,
      resurrected: 0,
    };

    for (const change of changes) {
      const current = await tx.getRecord(resource, change.id);
      const outcome = reconcileChange(
        current,
        change,
        options?.compareVersions,
      );
      if (!outcome.applied || outcome.record === undefined) {
        stats.ignored += 1;
        continue;
      }
      stats.applied += 1;
      await tx.putRecord(resource, outcome.record);
    }

    await tx.setCursor(resource, cursor.deltaLink);
    return stats as CommitStats;
  });
```

## 版本裁决

实体版本默认依次读取 `@version`、`version`、`Version`、`_version`、`rowVersion`、`RowVersion`、`@odata.etag`、`etag`、`ETag`。实体标识默认优先使用 `@odata.id`，因为墓碑通常只带该字段。

默认规则如下：

| 已存记录 | 新变更 | 结果 |
| --- | --- | --- |
| 任意 | 更高版本 | 应用（更新、墓碑或重建） |
| 已删除墓碑 | 更高版本更新 | 重建实体 |
| 存活实体 | 更低版本墓碑 | 忽略，不能删除更晚世代 |
| 任意 | 更低版本 | 忽略 |
| 任意 | 相同版本的同状态变更 | 幂等忽略 |
| 存活实体 | 相同版本墓碑 | 墓碑胜出并删除 |
| 已删除墓碑 | 相同版本更新 | 忽略，墓碑胜出 |
| 有版本记录 | 无版本变更 | 忽略，无法证明属于更晚世代 |

整数、数字字符串和数字 ETag（如 `W/"12"`）按数值比较；其他字符串按确定性的字符序比较，适合 ISO-8601 时间戳。其他版本方案可传入 `compareVersions`。

```ts
const sync = new ODataDeltaSync({
  // ...
  getId: (entry) => String(entry.CustomerID),
  getVersion: (entry) => entry["@odata.etag"] as string,
  compareVersions: (incoming, existing) => myVersionOrder(incoming, existing),
});
```

## 主要导出

- `ODataDeltaSync`（别名 `DeltaSync`、`DeltaSynchronizer`、`ODataDeltaClient`）
- `MemoryDeltaStore` / `InMemoryDeltaStore`
- `parseDeltaPage`
- `reconcileChange`
- `applyDeltaChanges`
- `compareServerVersions`
- `DeltaSyncError`、`DeltaFormatError`
- `createDeltaSync`、`runDeltaSync`、`resumeDeltaSync`

`runDeltaSync` 是一次性便捷函数；需要失败后续跑时请复用 `ODataDeltaSync` 实例或检查点。

## 开发

```bash
npm run typecheck
npm test
```

测试覆盖分页链、最终 `deltaLink`、中途抓取失败、提交失败、检查点迁移、缺失 `deltaLink`、HTTP 错误、实体重建、迟到墓碑、同版本墓碑和整批回滚。
