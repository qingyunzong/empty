# pathfill

TypeScript 图形库：解析有限的 move/line/close 路径命令（`M/m`、`L/l`、`Z/z`，整数坐标），
按 **even-odd（奇偶）** 或 **nonzero（非零绕数）** 规则判定整数查询点是否落在填充区域内。

## 语义约定

- **边界计内**：点落在任意边上（含顶点）即判定为内部，两种规则一致。
- **开放子路径隐式闭合**：填充时未以 `Z` 关闭的子路径自动补上末点到首点的闭合边。
- **方向证据**：每个环输出带符号面积（笛卡尔坐标系，正值为逆时针）、绕数、
  以及每条穿越射线的边的方向（`up`/`down`，贡献 `+1`/`-1`）。
- **命中环**：结果中的 `hits` 列出按当前规则各自包含查询点的子路径。

## API

```ts
import { parsePath, containsPoint, findSelfIntersections } from "./src/index.ts";

const subs = parsePath("M0 0 L20 0 L20 20 L0 20 Z M5 5 L15 5 L15 15 L5 15 Z");
const r = containsPoint(subs, { x: 10, y: 10 }, "nonzero");
// r.inside, r.onBoundary, r.winding, r.crossingCount
// r.hits  -> 命中的环; r.rings -> 每个环的方向证据 (orientation/winding/crossings)

findSelfIntersections(subs[0].points); // 逐边 O(n^2) 自交核验（短路径参考用）
```

- `parsePath(d: string): Subpath[]` — 解析命令串；`M` 后的多余坐标对按隐式 lineto 处理（同 SVG）。
- `containsPoint(subpaths, point, rule): FillResult` — `rule` 为 `"evenodd"` 或 `"nonzero"`。
- `findSelfIntersections(points): SelfIntersection[]` — 报告 `proper`（内部穿越）与
  `touch`（端点接触）两类自交，跳过相邻边。

## 测试

```sh
npm test        # tsc 编译到 dist/ 后用 node:test 运行
npm run typecheck
```

测试包含：解析器正误用例、两种填充规则下的内/外/边界判定、嵌套环同向与反向的
绕数差异、方向证据断言、八字环（bowtie）自交检测，以及对一组短路径在整数网格上
与独立参考实现（浮点射线法）逐点交叉核验，并逐边验证各环无自交。
