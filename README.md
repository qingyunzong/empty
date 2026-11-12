# 浏览器下载采集的生命周期归档

下载采集宿主可直接导入的 TypeScript 状态包。它接收乱序、分批到达的下载事件，
按全局序号对每个受影响下载做确定性重放，维护可归档的终态，并在终态被更早事件
撤销时输出“先删除后新增”的归档净差。

## 事件模型

每个事件同时携带 `eventId`（事件唯一 ID）、`seq`（全局唯一安全整数序号）与
`downloadId`（所属下载）。事件类型：

- `begin(id, url)`：开始下载。
- `progress(id, received, total)`：进度；`total` 未知时为 `null`。
- `complete(id, summary)`：完成，携带可归档摘要。
- `cancel(id)`：取消。

## 重放与归档规则

所有判断都基于按 `seq` 排序后的重放顺序，与事件到达顺序无关：

- **分批与受影响重放**：每次 `ingest` 只对本批涉及的下载重放，未涉及的下载不动。
- **暂存**：`begin` 尚未到达的事件进入该下载的暂存桶（含终态事件），不产生归档；
  `begin` 到达后的下一次重放统一裁决。
- **begin 唯一且最早**：一个下载只能有一个 `begin`，且其序号必须最小；`begin`
  存在时任何序号更小的非 `begin` 事件判为 `BEGIN_NOT_FIRST`。
- **首个终态**：序号最小的 `complete`/`cancel` 为首个终态；序号晚于它的事件一律
  忽略（包括迟到的 `progress` 与第二个终态）。
- **progress 约束**：`received` 单调非降；`total` 只能由未知（`null`）变为已知一次，
  之后不可改变；任何 `received` 超过已知 `total` 都非法。
- **complete 就绪条件**：仅当 `total` 已知且最终 `received === total` 时才归档；
  否则保留终态、等待序号更早的 `progress` 到达后再次重放。
- **cancel 立即就绪**：不依赖任何 `progress`，立刻进入归档。
- **终态撤销与净差**：新到的更早终态会改变重放结果，旧归档被撤销。每次 `ingest`
  返回 `deltas`，逐项给出 `removed`（旧归档或 `null`）与 `added`（新归档或 `null`）。
- **幂等重投**：`eventId` 相同且结构相等的事件视为重投，记到 `ignoredDuplicates`，
  不参与重放。
- **冲突与整批回滚**：`eventId` 复用但载荷不同、`seq` 全局冲突、重复 `begin`、
  非法顺序或非法 `progress` 都会抛出 `BatchRejectedError`，并撤销该批次已写入的全部
  事件与归档变更，存储回到批次前状态。

## 用法

```ts
import { DownloadStateStore, BatchRejectedError } from './index.js';

const store = new DownloadStateStore();

// progress 先到、begin 迟到：片段暂存，不归档。
store.ingest([{ kind: 'progress', eventId: 'p1', seq: 2, downloadId: 'd', received: 50, total: 100 }]);

const result = store.ingest([
  { kind: 'begin', eventId: 'b1', seq: 1, downloadId: 'd', url: 'https://x/a' },
  { kind: 'progress', eventId: 'p2', seq: 3, downloadId: 'd', received: 100, total: 100 },
  { kind: 'complete', eventId: 'c1', seq: 4, downloadId: 'd', summary: 'done' },
]);

result.deltas; // [{ downloadId: 'd', removed: null, added: { kind: 'complete', ... } }]
store.listArchives();

try {
  store.ingest([{ kind: 'progress', eventId: 'bad', seq: 5, downloadId: 'd', received: 0, total: 100 }]);
} catch (error) {
  if (error instanceof BatchRejectedError) {
    // 整批已回滚，error.code 标识原因，例如 RECEIVED_DECREASED。
  }
}

const snapshot = store.exportSnapshot();        // 可 JSON 持久化
const restored = DownloadStateStore.importSnapshot(snapshot);
```

## API 一览

- `new DownloadStateStore()`：创建空存储。
- `ingest(batch): BatchResult`：投递一批事件，返回 `accepted`、`ignoredDuplicates`、
  `affectedDownloads` 与归档 `deltas`；非法时抛 `BatchRejectedError`。
- `getDownload(id): DownloadView | null`：只读查询某下载当前阶段（`staged` /
  `active` / `complete` / `cancel`）、进度、终态就绪标记与归档快照。
- `listArchives(): ArchivedDownload[]`：当前全部归档，按下载 ID 排序。
- `exportSnapshot()` / `DownloadStateStore.importSnapshot(snapshot)`：状态包持久化与恢复。
- `replayDownload(id, events)`：纯函数重放，便于宿主在存储之外复用规则。

错误码（`BatchRejectedError.code`）：`MALFORMED_EVENT`、`CONFLICT_EVENT_ID`、
`CONFLICT_SEQ`、`DUPLICATE_BEGIN`、`BEGIN_NOT_FIRST`、`RECEIVED_DECREASED`、
`TOTAL_CHANGED`、`RECEIVED_EXCEEDS_TOTAL`。

## 目录与构建

- `src/types.ts`：事件与归档类型。
- `src/errors.ts`：结构校验、重投相等判定与 `BatchRejectedError`。
- `src/replay.ts`：单下载按序号重放的纯函数引擎。
- `src/store.ts`：暂存桶、批次事务/回滚、归档净差与状态包导入导出。
- `test/`：`node:test` 用例，覆盖到达排列（确定性洗牌 40 个种子）、迟到取消、
  终态撤销、重投幂等与整批回滚。

当前运行时的 Node 未编入 TypeScript 剥离支持，因此通过全局 `tsc` 离线编译到
`dist/` 后用内置 test runner 执行：

```bash
npm run build      # 严格类型检查 + 产出 .js / .d.ts 到 dist/
npm test           # 转译 src 与 test 后运行 dist/test 下的全部用例
npm run typecheck  # 仅类型检查，不产出文件
```
