# integer-polygon-editor

整数坐标多边形（外环 + 洞）的版本化编辑库。移动顶点后做**全量精确校验**，
拒绝一切自交、环间穿越、洞跑出外环的情形——**触碰也算冲突**。批量移动在
全部校验通过后才原子发布为新版本；所有旧版本保持可读。仅使用 TypeScript +
Node.js 内置库，零运行时依赖。

## 规则

- 所有坐标必须是安全整数；所有几何判定用 BigInt 精确计算，无浮点误差。
- 任意两条边（同环或跨环）不得相交：穿过（cross）、触碰（touch）、共线
  重叠（overlap）均为冲突。同环相邻边只允许共享那一个公共端点。
- 每个洞必须严格位于外环之内，且不得嵌套在另一个洞内。
- 每个环至少 3 个顶点，不允许零长度边。
- 校验方式为**所有边对的精确扫描**（O(E²)，BigInt），同时作为测试的
  ground-truth；测试中还用一个独立编写的蛮力校验器（`test/oracle.ts`）
  对结果做交叉核对（含 400+300 组种子化随机模糊用例）。

## API

```ts
import { PolygonEditor } from "./src/index";

const editor = new PolygonEditor({
  outer: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
  holes: [[{ x: 2, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 4 }, { x: 2, y: 4 }]],
}); // 初始多边形非法时抛 PolygonValidationError（含 conflicts 证据）

// 单点移动（等价于单元素批量）
const r1 = editor.moveVertex({ ring: 0, index: 0 }, { x: -2, y: -2 });
// r1 = { ok: true, version: 1, polygon: ... }

// 批量移动：全部应用后整体校验，通过才发布；任一冲突则整体拒绝、状态不变
const r2 = editor.moveVertices([
  { target: { ring: 1, index: 0 }, to: { x: 3, y: 3 } },
  { target: { ring: 1, index: 2 }, to: { x: 5, y: 5 } },
]);
// 拒绝时 r2 = { ok: false, conflicts: [...] }，每条冲突带具体边证据，例如：
// {
//   kind: "self-intersection",
//   a: { ring: 0, edge: 0 }, b: { ring: 0, edge: 2 },
//   intersection: { type: "cross" },
//   message: "outer edge 0 (0,0)->(2,6) crosses outer edge 2 (4,4)->(0,4)"
// }

editor.version;        // 当前版本号
editor.current;        // 当前多边形（冻结快照）
editor.getVersion(0);  // 旧版本始终可读（不可变）
```

环编号：`0` 为外环，`k >= 1` 为 `holes[k - 1]`。边 `i` 连接顶点 `i` 与
`(i + 1) mod n`。

## 冲突类型

- `self-intersection` / `ring-intersection`：边对冲突，附 `intersection`
  （`cross` / `touch` / `overlap`，后两者带坐标）与两条边的完整端点信息。
- `hole-outside-outer`：洞跑出外环。
- `nested-hole`：洞嵌套在另一个洞内。
- `degenerate-ring`：顶点数不足或零长度边。
- `invalid-coordinate`：坐标不是安全整数。

## 测试

```sh
npm test    # tsc 编译到 dist/ 后用 node --test 运行
```

实际运行结果（Node v22.22.1，tsc 7.0.2）：

```
# dist/test/geometry.test.js   tests 8   pass 8   fail 0
# dist/test/polygon.test.js    tests 13  pass 13  fail 0
# dist/test/editor.test.js     tests 12  pass 12  fail 0
# 合计 33 个测试全部通过（含两组种子化随机模糊交叉核对）
```
