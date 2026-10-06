# incremental-sessionizer

按「同一用户、相邻事件间距 ≤ `gapMs`」归并会话的增量会话化库（TypeScript）。

## 语义

- **归并**：同一用户的事件按 `(timestamp, id)` 排序后，相邻间距 ≤ `gapMs` 的属于同一会话。
- **乱序桥接**：乱序到达的事件若落在两个会话之间且与两侧间距都 ≤ `gapMs`，会把两个会话桥接合并为一个。
- **撤回拆分**：`retractEvent` 移除事件后，原会话可能拆成两个（或收缩、消失）。
- **水位与迟到**：`advanceWatermark(wm)` 推进水位（单调）。`timestamp < wm - allowedLatenessMs`
  的事件被视为过迟而丢弃；水位推进时回收不再可能被任何允许迟到事件触及的会话
  （`end < wm - allowedLatenessMs - gapMs`）。
- **差量输出**：每次变更返回 `SessionDelta[]`——先 `retracted`（旧版本会话）后 `added`
  （新版本会话）。`sessionId` 由内容确定性生成，下游可按 id 应用 retract/add。

## 使用

```ts
import { Sessionizer } from './src/sessionizer';

const s = new Sessionizer({ gapMs: 30_000, allowedLatenessMs: 300_000 });
s.addEvent({ id: 'e1', userId: 'u1', timestamp: 0 });        // -> [added S1]
s.addEvent({ id: 'e2', userId: 'u1', timestamp: 50_000 });   // -> [added S2]
s.addEvent({ id: 'e3', userId: 'u1', timestamp: 25_000 });   // 乱序桥接 -> [retract S1, retract S2, added S3]
s.retractEvent('e3');                                        // 撤回拆分 -> [retract S3, added S1, added S2]
s.advanceWatermark(1_000_000);                               // 触发状态 GC
```

## 核验

`src/reference.ts` 提供全排序重新分组的参考实现；`test/differential.test.ts`
在随机操作序列（乱序/迟到/撤回/水位推进）上逐步比对增量引擎与参考实现的状态，
并验证差量流可物化为相同状态（覆盖「桥接再撤回」场景）。

## 测试

```sh
npm test   # tsc 编译 + node --test
```
