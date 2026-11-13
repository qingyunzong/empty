# OData delta link 世代切换

企业目录采集服务要可直接接入 TypeScript OData delta 遍历组件，区分 nextLink、deltaLink、removed reason 和分页内同实体多次变化。只有完整走完当前世代才提交新 deltaLink；中途取消沿原 nextLink 恢复。服务端返回410时开启全量新世代，但旧删除记录不得污染新快照。

## 用法

```ts
import { DeltaCollector } from "./index.js";

const collector = new DeltaCollector({
  initialUrl: "https://dir.example/users/delta",
  fetcher: async (url, signal) => {
    const res = await fetch(url, { signal });
    return { status: res.status, body: res.status === 200 ? await res.json() : undefined };
  },
  store, // 可选，默认 InMemoryCheckpointStore；生产环境用持久化 CheckpointStore
  onEvent: (e) => console.log(e),
});

await collector.run({ signal }); // 走完一个世代；取消后下次 run() 沿原 nextLink 恢复
```

- `npm run typecheck` — 类型检查
- `npm test` — 编译到 `.test-build/` 并运行 node:test 测试
