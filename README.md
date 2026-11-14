# 浏览器请求导航世代归属

可导入的 TypeScript 导航归属组件。它把 request、redirect、frame detach、
same-document navigation 与 lifecycle 事件绑定到唯一文档世代，并从规范化
排序后的事件重放请求树。

## 使用

```ts
import { NavigationTracker } from "./index.js";

const tracker = new NavigationTracker();

tracker.onFrameNavigated({
  frameId: "main",
  loaderId: "doc-1",
  url: "https://example.test/",
  timestamp: 1,
});

tracker.onRequestWillBeSent({
  frameId: "main",
  loaderId: "doc-1",
  requestId: "r1",
  url: "https://example.test/api",
  timestamp: 2,
});

tracker.onResponseReceived({
  frameId: "main",
  loaderId: "doc-1",
  requestId: "r1",
  status: 200,
  url: "https://example.test/api",
  timestamp: 3,
});

const tree = tracker.requestTree; // 只包含当前活跃文档世代
const snapshot = tracker.getSnapshot(); // 含历史世代、迟到响应与完整树
```

`ingest`/`handle`/`dispatch` 也接受 CDP 事件包：

```ts
tracker.ingest({
  method: "Network.requestWillBeSent",
  params: {
    requestId: "r2",
    loaderId: "doc-1",
    frameId: "main",
    request: { url: "https://example.test/data", method: "GET" },
    timestamp: 4,
  },
});
```

也支持显式 `seq` 或 `sequence` 排序键。批量重放：

```ts
import { replayNavigationEvents } from "./index.js";

const snapshot = replayNavigationEvents(events);
```

## 语义

- `frameNavigated` 为对应 frame 创建新的唯一文档世代；同一 `loaderId` 的重复事件是幂等的。
- `navigatedWithinDocument` 不创建新文档，只把路由/URL 变更绑定到当前世代。
- `frameDetached` 撤销该 frame 及其后代；子 frame 独立换页同样只撤销自己的旧子树，
  不影响父 frame 和兄弟 frame。
- 每个 request 记录创建时的 `generationId`。response 始终按 request 的世代归属；
  旧世代已撤销时只作为迟到响应保存在历史中，绝不写入新页面树。
- 所有状态由纯 reducer 在规范化事件序列上重建，乱序输入得到相同请求树。

## 测试

```sh
npm test
npm run typecheck
```
