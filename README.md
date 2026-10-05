# rect-cover-db

整数轴对齐矩形的空间库（TypeScript，仅依赖 Node.js 内置模块）。

- 矩形为半开区间 `[x0, x1) × [y0, y1)`，坐标必须为整数。
- **持久快照**：`insert` / `remove` 返回新快照，旧快照永不被修改（写时复制）。
- **`coveredAtLeast(k)`**：把被至少 `k` 个矩形覆盖的区域分解为**规范的两两不相交矩形**，
  每个输出矩形带有覆盖它的有序来源 ID 集合 `sources`；覆盖次数 `< k` 的区域（洞）不出现在输出中，洞得以保留。
- **规范性**：输出只取决于当前存储的 `(rect, source)` 多重集合，与增删顺序无关。

## 算法

扫描线：x 方向端点事件按坐标**同批处理**（同一 x 的所有加入/移除一起生效），
相邻事件坐标之间形成 x 条带；条带内对 y 方向再做一次同批事件扫描，
得到来源集合大小 `>= k` 的极大 y 区间（bands）。相邻 x 条带的 bands
（y 区间与来源集合都相同）相同则横向合并，得到规范输出。

测试对照模型（`src/model.ts`）：对微小整数网格**逐格**暴力计算每个单位格的来源集合，
核对扫描线输出的面积、逐格来源集合、不相交性与完整性。

## 用法

```ts
import { RectSnapshot } from "rect-cover-db";

let s = RectSnapshot.empty();
const a = s.insert({ x0: 0, y0: 0, x1: 3, y1: 3 }, "source-a");
const b = a.snapshot.insert({ x0: 1, y0: 1, x1: 4, y1: 4 }, "source-b");

b.snapshot.coveredAtLeast(2);
// => [ { x0: 1, y0: 1, x1: 3, y1: 3, sources: ["source-a", "source-b"] } ]

const c = b.snapshot.remove(a.id);   // 删除按 insert 返回的 id
b.snapshot.coveredAtLeast(1);        // 旧快照 b 不受 remove 影响
```

## 构建与测试

```sh
npm test   # = tsc -p tsconfig.json && node --test dist/test/*.test.js
```

环境要求：Node.js（开发环境为 v22.22.1）与 TypeScript 编译器（开发环境为全局 tsc 7.0.2）。
本环境离线无法安装 `@types/node`，`types/node-shims.d.ts` 提供了测试所用
`node:test` / `node:assert/strict` 的最小类型声明；有网环境可
`npm i -D @types/node` 后删除该文件。

## 实际测试结果

在上述环境执行 `npm test`，实际输出（10 项全部通过）：

```
ok 1 - overlapping rects decompose into canonical disjoint slabs
ok 2 - same-x endpoint events are batched: adjacent rects merge, no zero-width slabs
ok 3 - holes are preserved as gaps in the output
ok 4 - k-coverage hole: ring covered twice around a singly covered center
ok 5 - old snapshots are never modified by later inserts/removes
ok 6 - decomposition is canonical: independent of insertion order
ok 7 - remove restores pre-insert coverage exactly
ok 8 - invalid inputs are rejected
ok 9 - randomized cross-check against per-cell model (area and sources)
ok 10 - randomized immutability: full history of snapshots stays intact
# tests 10
# pass 10
# fail 0
```

其中第 9 项为 200 组随机试验（7×7 网格、4 个来源、随机增删），对 k=1,2,3
逐格核对面积与来源集合，并校验过程中冻结的旧快照结果不变。
