字幕渲染宿主需要可导入的TypeScript排版组件，字幕有半开时间区间、水平像素区间、正整数行高、首选起始行和稳定ID。同一时刻水平区间重叠的字幕不能占用共同的行，按开始时间和ID排序，为每条选不小于首选行的最小合法起始行。更正时取新旧字幕时间重叠图中受影响的整个连通分量重排，其他行号保持；调用方可查询不可变布局版本。以全量分量重算核验同刻起止、长字幕连接多组、删除后分裂及不同高度字幕，时间或水平区间仅端点相接不算重叠。

## 用法

```ts
import { SubtitleLayoutEngine, layoutAll } from "dlks-q262";

const engine = new SubtitleLayoutEngine([
  { id: "a", start: 0, end: 10_000, x0: 0, x1: 720,
    lineHeight: 1, preferredLine: 0 },
]);

// 更正：先删后增，返回新的不可变布局版本
const v1 = engine.update({
  remove: ["a"],
  upsert: [{ id: "b", start: 5_000, end: 12_000, x0: 0, x1: 360,
             lineHeight: 2, preferredLine: 0 }],
});

v1.lineOf("b");        // 起始行
engine.version(0);     // 历史不可变版本仍可查询
engine.currentVersion; // 最新版本
```

- 时间区间 `[start, end)` 与水平像素区间 `[x0, x1)` 均为半开，仅端点相接不算重叠。
- 时间且水平同时重叠的字幕冲突，不得共用 `[line, line + lineHeight)` 内的任何行。
- 贪心规则：按 `(start, id)` 排序，逐条取不小于 `preferredLine` 的最小合法起始行。
- 增量更正只重排新旧字幕时间重叠图中受影响的连通分量，分量外行号保持不变，结果与 `layoutAll` 全量重算一致。

## 脚本

- `npm run build`：编译到 `dist/`。
- `npm test`：构建并运行 `node:test` 测试（含与全量重算对拍的随机差分测试）。
