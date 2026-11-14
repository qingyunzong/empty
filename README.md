# SPA 网络静默判定

页面抓取器要可直接接入 TypeScript 网络静默状态机，区分持续连接、轮询、service worker、预加载和用户配置的忽略规则。静默窗口从最后一个相关请求终态起算，导航切换清空旧请求；取消与超时返回当前阻塞证据，不以固定 sleep 判定完成。

## 用法

```ts
import { NetworkIdleMonitor } from "./network-idle.js";

const monitor = new NetworkIdleMonitor({
  quietWindowMs: 500,
  ignoreRules: [{ url: /analytics/ }, { resourceType: "image" }],
});

// 抓取器把网络事件转发进来：
monitor.requestStarted({ id, url, resourceType, fromServiceWorker, isPreload });
monitor.requestSettled(id, { reason: "finished" }); // finished | failed | aborted
monitor.navigationCommitted(); // 导航切换，清空旧请求

const result = await monitor.waitForIdle({ timeoutMs: 10_000, signal });
// { status: "idle", idleSince, waitedMs }
// { status: "timeout" | "cancelled", waitedMs, blocking: BlockingEvidence[] }
```

## 判定规则

- **持续连接**：`websocket` / `eventsource` 单独跟踪（`openPersistentConnections`），永不阻塞静默。
- **轮询**：同一 `method + URL` 在 `pollingWindowMs` 内终态达到 `pollingThreshold` 次即判定为轮询端点，后续请求不再阻塞；已判定端点见 `detectedPollingEndpoints`。
- **Service worker**：`fromServiceWorker` 请求默认不阻塞，可用 `countServiceWorkerRequests` 改为计入。
- **预加载**：`isPreload` 请求默认计入阻塞，可用 `countPreloadRequests` 忽略。
- **忽略规则**：`ignoreRules` 支持 `url`（正则或子串）、`resourceType`、`method` 组合匹配，命中的请求完全不参与判定。
- **静默窗口**：从最后一个相关请求的终态时刻起算 `quietWindowMs`，期间出现新的相关请求则窗口重置；已静默足够久时立即返回，不做固定 sleep。
- **取消与超时**：`waitForIdle` 不抛出，`timeoutMs` 到期或 `AbortSignal` 触发时返回当前 `blocking` 证据（在飞请求的 id、url、kind、存活时长）。

## 脚本

- `npm run typecheck`：类型检查。
- `npm test`：编译到 `dist/` 后运行 `node --test`。
