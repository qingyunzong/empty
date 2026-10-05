# rect-coverage-store

整数轴对齐矩形的持久化空间库。每个矩形挂在一个来源 ID 下；`coverage(k)`
查询把"被至少 k 个矩形覆盖"的区域分解为**规范的不相交矩形集**，每个输出
矩形附带覆盖它的确切来源 ID 集合。覆盖不足 k 的区域（洞）保持为空，输出
矩形绝不跨越洞。所有修改返回新快照，旧快照永远不变。

仅使用 TypeScript + Node.js 内置库（`node:test` / `node:assert`），无第三方依赖。

## 用法

```ts
import { rect, RectStore } from "rect-coverage-store";

const s0 = RectStore.empty<string>();
const s1 = s0.add("a", rect(0, 0, 4, 4));
const s2 = s1.add("b", rect(2, 2, 6, 6));
const s3 = s2.remove("a");          // s1、s2 不受影响

s2.coverage(2);
// => [ { rect: { x0: 2, y0: 2, x1: 4, y1: 4 }, sources: ["a", "b"] } ]
```

- `add(id, rect)`：新增/替换该 ID 的矩形，返回新快照。
- `remove(id)`：删除该 ID（不存在则原样返回当前快照）。
- `coverage(k)`：返回按 `(x0, y0, x1, y1)` 排序的 `CoverageRect[]`，
  `sources` 为规范排序（数字升序在前，字符串字典序在后）。
- 矩形为半开区间 `[x0, x1) × [y0, y1)`，坐标必须为整数且面积为正。

## 算法

- **扫描线**：x 方向扫描，所有同一坐标的端点事件（开/闭）作为**同批**
  在相邻条带之间一次性应用；条带内部对 y 做同样的分批扫描。因此边贴边
  的矩形不会产生零宽条带，也不会把同源集合的区间误切开。
- **规范合并**：条带内把来源集合相同的连续 y 段合并，再跨相邻条带把
  `(y0, y1, sources)` 完全相同的矩形沿 x 方向延展。结果与插入顺序无关。
- **持久化**：写时复制（copy-on-write）快照，旧版本可继续查询。
- **逐格核对模型**（`src/gridmodel.ts`）：在微小整数网格上逐单位格计算
  精确来源集合，核对扫描结果的面积与来源，并要求 ≥k 的格子被恰好覆盖
  一次（洞不被覆盖）。

## 测试

```sh
npm test    # tsc 编译后用 node --test 运行
```

### 实际运行结果（2026-10-05，Node v22.22.1，TypeScript 7.0.2）

```
▶ validation
  ✔ rejects non-integer and degenerate rectangles
  ✔ rejects invalid k
  ✔ empty store yields empty coverage
▶ basic coverage
  ✔ single rectangle at k=1
  ✔ overlap of two rectangles at k=2
  ✔ k=1 splits regions by distinct source sets
  ✔ supports numeric ids with canonical ordering
▶ holes
  ✔ a ring of rectangles keeps its hole uncovered
  ✔ nested rectangles: k=2 keeps only the core, k=3 leaves a hole
▶ persistence
  ✔ mutations never change existing snapshots
  ✔ add replaces an existing id; removing a missing id is a no-op
▶ batched sweep events
  ✔ touching rectangles produce no zero-width output
  ✔ end/start at the same coordinate cancel without splitting runs
▶ canonical output
  ✔ is independent of insertion order
▶ randomized cross-check against the unit-grid model
  ✔ sweep matches cell-by-cell area and sources on tiny grids
  ✔ random mutation sequences keep old snapshots intact
ℹ tests 16
ℹ suites 7
ℹ pass 16
ℹ fail 0
```

## 结构

- `src/rectstore.ts` — 持久化存储 + 扫描线 k 覆盖分解
- `src/gridmodel.ts` — 微小网格逐格暴力核对模型
- `test/rectstore.test.ts` — `node:test` 测试（含随机化对拍）
- `types/node.d.ts` — Node 内置模块的最小类型声明（避免外部 @types 依赖）
