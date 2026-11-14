# Service Worker 缓存旁路验证

页面数据采集要可直接接入 TypeScript 请求来源判定组件，区分网络、service worker、memory cache 与 disk cache 响应。任务可要求新鲜网络证据；此时先等待 SW 失控并创建新文档世代，再核对 response source，不能仅清理一个 cache 后宣称旁路成功。

## 组件

- `src/response-source.ts`：`classifyResponse(evidence)` 按三层证据（CDP 显式标志 → PerformanceResourceTiming 语义字段 → 传输尺寸启发式）判定 `network` / `service-worker` / `memory-cache` / `disk-cache` / `unknown`，并返回判定依据便于审计。
- `src/sw-bypass.ts`：`verifyFreshNetworkEvidence(env, url)` 编排完整旁路流程——注销全部 SW 并轮询等待 `controller === null`（超时抛 `BypassError`）→ 完整导航创建新文档世代（世代号未前进即抛错）→ 采集证据并核对来源为 `network`，否则返回 `ok: false` 及原因。环境通过 `BrowserEnv` 接口注入，可由页面内脚本或 CDP 适配层实现。

## 使用

```sh
npm run typecheck   # 类型检查
npm test            # 编译到 dist/ 并运行 node:test
```

```ts
import { verifyFreshNetworkEvidence } from "./index.ts";

const result = await verifyFreshNetworkEvidence(env, "https://example.com/data");
if (!result.ok) console.error(result.failureReason);
```
