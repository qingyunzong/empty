# 下载任务响应归因

浏览器采集器可直接接入的 TypeScript 下载归因库。它把用户动作、popup、重定向链、响应头（尤其是 `Content-Disposition`）与浏览器 download 事件关联起来，并在文件落盘后核对长度和摘要。

核心保证：

- 一次用户动作可关联多个下载候选，每个候选独立认领。
- 响应只有在 URL 链和因果时间都成立时才能认领下载。
- 响应认领是单向锁：一旦确定，后到的更高分响应不会替换它。
- 文件完成后按实际字节长度和摘要校验，冲突结果保留首次结论。
- 迟到事件只能补全缺失字段，不能覆盖已确定的响应、文件或校验结论。

## 接入

```ts
import { BrowserDownloadCollector, computeSha256 } from "./index.ts";

const collector = new BrowserDownloadCollector();

collector.trackAction({
  id: "action-1",
  at: Date.now(),
  kind: "click",
  url: "https://shop.example/download",
  documentUrl: "https://shop.example/product/42",
  tabId: 12,
});

collector.trackPopup({
  id: "popup-1",
  actionId: "action-1",
  at: Date.now(),
  url: "https://shop.example/files/report.zip",
  tabId: 13,
});

collector.trackResponse({
  requestId: "request-1",
  startedAt: Date.now(),
  at: Date.now(),
  url: "https://shop.example/files/report.zip",
  finalUrl: "https://cdn.example/objects/report.zip?sig=...",
  redirectChain: [
    { url: "https://shop.example/files/report.zip", status: 302 },
    { url: "https://cdn.example/objects/report.zip?sig=..." },
  ],
  headers: {
    "Content-Type": "application/zip",
    "Content-Length": "1024",
    "Content-Disposition": "attachment; filename=\"report.zip\"",
    "Content-Digest": "sha-256=:...:",
  },
  requestInitiator: "https://shop.example/download",
  tabId: 12,
});

collector.trackDownload({
  id: "download-1",
  at: Date.now(),
  url: "https://cdn.example/objects/report.zip?sig=...",
  filename: "report.zip",
  totalBytes: 1024,
});

const result = await collector.completeFile({
  downloadId: "download-1",
  bytes: fileBytes,
});

console.log(result.state);      // "verified" | "failed" | "completed" | ...
console.log(result.response?.requestId);
console.log(result.action?.id);
console.log(result.sha256);
```

`BrowserDownloadCollector` 只是采集门面，也可以直接使用平台无关的 `DownloadAttributor`。统一入口 `ingest()` 接受带 `type` 的事件，适合从扩展的 `webRequest`、`downloads`、content script 消息队列转发。

## 因果与候选

响应到下载的认领至少满足：

1. 显式 `requestId` / `responseId` / `downloadId` 一致；或下载 URL 与响应 URL、最终 URL、重定向链中的某个 URL 匹配。
2. `responseStart <= download.at`，并且没有超出响应到下载的时间窗口。
3. 若存在相关用户动作，则 `action.at <= responseStart`，且响应在动作后的时间窗口内。

采集器应把响应的 `at` 设为收到响应头/首字节的时间，并把响应体完成时间放在 `completedAt`。浏览器可能在响应体完成前就触发 download 事件；若把 `at` 误填成 `onCompleted` 时间，会破坏因果顺序。

响应到动作的匹配可使用：

- 响应上的显式 `actionId`；
- popup 的 `actionId` / `openerActionId` 及其导航链；
- 动作 URL、目标 URL、popup URL 与响应 URL/重定向链匹配；
- 响应的 `requestInitiator` 与动作所在文档 URL 匹配。

URL 默认先做去掉 fragment 的精确匹配；查询串变化时（签名下载 URL 常见）可退回同源同路径匹配，可用 `allowQuerylessUrlMatch: false` 禁用。时间窗口可配置：

```ts
new BrowserDownloadCollector({
  clockSkewMs: 50,
  maxActionToResponseMs: 30_000,
  maxResponseToDownloadMs: 120_000,
});
```

`candidatesForAction(actionId)` 返回动作当前的全部响应候选及拒绝原因；`attributionsForAction(actionId)` 返回已经认领该动作的下载结果。

## 文件核对

`completeFile()` 优先从调用方给定字节计算摘要，不盲信预计算摘要。期望长度来源按优先级包括：

- `download.totalBytes`、`download.fileSize`；
- `Content-Range` 的总长度；
- 非压缩响应的 `Content-Length`。

支持的摘要来源包括 `Content-Digest`、`Digest`、`x-checksum-sha256`、`x-amz-checksum-sha256`、`x-goog-hash`、`Content-MD5`，以及 `download.digest`。SHA-1/256/384/512 可由 Web Crypto 从实际字节重算；MD5 等不可计算算法只在调用方直接提供实际摘要时比较。

结果状态：

- `verified`：已认领响应，文件长度/摘要核对通过；
- `failed`：文件已落盘，但长度或摘要不匹配；
- `completed`：文件已完成，但缺少可核对的声明或响应尚未到达；
- `claimed`：响应已认领，等待文件落盘；
- `pending`：尚无满足约束的响应。

## 迟到事件

事件同时保留观测时间与到达顺序。结果一旦确定：

- 后到响应只进入 `ignored` 审计，不替换 `result.response`；
- 后到 download 事件只能补全缺失字段，不覆盖 URL、文件名、长度等已有值；
- 后到文件完成事件若长度/摘要冲突，保留首次文件结论；需要显式报错时设置 `throwOnFileConflict: true`。

`result.ignored` 会记录 `kind`、事件 `id`、原因与到达序号，便于采集器排障。

## 测试

```bash
npm test
npm run typecheck
```

测试覆盖完整动作→popup→重定向→响应→下载→落盘链路、URL/时间拒绝、一动作多候选、`filename*` 解析、长度/摘要失败以及迟到事件锁定。
