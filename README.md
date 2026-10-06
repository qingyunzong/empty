# subtitle-editor

字幕编辑库（TypeScript，零运行时依赖）：支持区间插入、裁剪、撤销，
并按遮挡规则输出最大连续可见段及其来源字幕。

## 规则

- 区间为半开区间 `[start, end)`，单位毫秒，`end` 点不可见。
- 同一时刻多条字幕交叠时：**层（layer）大者遮挡层小者；层相同时后插入者优先**。
- `undo()` 是完整版本回滚：恢复到操作前的同一版本（版本号、字幕列表、id/seq 计数器均一致）。

## API

```ts
import { SubtitleEditor } from "./src/subtitle-editor.js";

const ed = new SubtitleEditor();
const a = ed.insert({ layer: 0, start: 0, end: 100, text: "低层" });
const b = ed.insert({ layer: 1, start: 40, end: 60, text: "高层" });

ed.visibleSegments();
// [
//   { start: 0,  end: 40,  source: a, layer: 0, text: "低层" },
//   { start: 40, end: 60,  source: b, layer: 1, text: "高层" },
//   { start: 60, end: 100, source: a, layer: 0, text: "低层" },
// ]

ed.crop(a, 10, 90);   // 将 a 裁剪到 [10, 90)（取交集；交集为空则移除）
ed.undo();            // 撤销裁剪，恢复裁剪前的同一版本
ed.visibleAt(50);     // 50ms 处可见的字幕
ed.version;           // 当前版本号
```

- `insert({ layer, start, end, text? }): SubtitleId`
- `crop(id, start, end): boolean` — id 不存在返回 `false`，且不产生版本变化
- `undo(): boolean` — 无可撤销操作时返回 `false`
- `visibleSegments(): VisibleSegment[]` — 最大连续可见段（同源相邻段已合并）
- `visibleAt(t): SubtitleView | null`
- `list() / get(id) / version / canUndo`

## 测试

```sh
npm test   # tsc 编译 + node --test（需全局或本地可用的 tsc）
```

测试分两部分：

1. `test/subtitle-editor.test.ts` — 确定性单元测试：半开区间边界、遮挡规则、
   裁剪、撤销恢复同一版本等。
2. `test/randomized-raster.test.ts` — 随机对照测试：多种子下各执行 400 次随机
   插入/裁剪/撤销，每步将库的输出与独立的逐毫秒栅格参照实现
   （`test/raster-reference.ts`）全量比对（版本号、字幕列表、可见段、抽样
   `visibleAt`），并用独立快照栈验证每次撤销都恢复到操作前的同一版本。
