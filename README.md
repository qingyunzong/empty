# 动态 Session Window 状态库

可导入的 TypeScript 会话窗口状态实现，适用于事件乱序到达、每条事件自带
gap、窗口已发布后仍可能被新事件合并的实时分析场景。

## 语义

- 每条事件定义前向区间 `[timestamp, timestamp + gapMs]`。
- 同一 key 下，区间相交或首尾相接的事件属于同一个会话；会话就是这些区间的
  连通分量，与事件到达顺序无关。
- 窗口的 `start` 是最早事件时间，`end` 是 `max(timestamp + gapMs)`。
- 每次写入都会立即发布窗口版本。若新事件扩展或合并窗口，旧版本进入
  `retracted`，新版本进入 `emitted`。一次桥接多个窗口时只会发布一个合并版本。
- watermark 是单调推进的。满足 `window.end <= watermark` 的窗口被封闭；
  封闭窗口不再被修改，后续事件也不会把它们重新纳入计算。
- 时间戳不大于 watermark 的事件视为迟到事件，返回 `accepted: false` 和
  `reason: "late"`，不产生状态变更。

## 使用

```ts
import { SessionWindowState } from './index.ts';

type Click = {
  id: string;
  ts: number;
  timeout: number;
  user: string;
};

const state = new SessionWindowState<Click>({
  getTimestamp: (event) => event.ts,
  getGap: (event) => event.timeout,
  getKey: (event) => event.user,
  getId: (event) => event.id,
});

state.add({ id: 'a', ts: 0, timeout: 5, user: 'u1' });
state.add({ id: 'b', ts: 12, timeout: 5, user: 'u1' });

const bridge = state.add({ id: 'c', ts: 5, timeout: 7, user: 'u1' });

// bridge.retracted.length === 2
// bridge.emitted.length === 1
// bridge.emitted[0] 覆盖 [0, 17)，事件顺序为 a、c、b

const closed = state.advanceWatermark(17);
// closed.closed.length === 1，之后该窗口不可再改写
```

如果事件直接使用 `timestamp`、`gapMs`（或 `gap` / `sessionGapMs`）、`key` 和
`id` 字段，可以不传访问器：

```ts
const state = new SessionWindowState({ gapMs: 10 });
state.add({ id: 'e1', timestamp: 100, key: 'k1' });
```

## 返回结果

`add(event)` 返回 `IngestResult`：

- `accepted`：是否写入。
- `reason`：`late`、`duplicate` 或 `duplicate-id`。
- `retracted` / `retractions`：被替换或合并的旧窗口版本。
- `emitted` / `emissions`：新发布版本；桥接时长度为 1。
- `openWindows` / `windows`：写入后该 key 的当前开放窗口。

`advanceWatermark(watermark)` 返回 `WatermarkResult`，其中 `closed` /
`closedWindows` 是本次变为不可变的最终窗口。封闭是生命周期变化，不产生数据
版本撤销。

其他查询接口包括 `getOpenWindows`、`getClosedWindows`、`getAllWindows`、
`getWindow`、`getEvents` 和 `snapshot`。`connectedComponents(events,
options)` 与 `computeSessionWindows(events, options)` 提供无状态的连通分量/
窗口计算，便于批处理校验。

## 验证

`npm test` 会编译 TypeScript 并运行测试。测试用小型事件集穷举全部到达顺序，
将最终窗口与独立的“两两区间相交 + 并查集”连通分量实现逐一对拍；同时检查
每次发布的版本都能被后续撤销操作精确覆盖。

```bash
npm run typecheck
npm test
```
