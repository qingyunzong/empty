# edit-map

对同一原文应用一组半开区间替换，产出新文本以及原文 ↔ 新文的双向位置映射。
仅使用 TypeScript 与 Node.js 内置库（`node:test` / `node:assert`），无运行时依赖。

## 语义

- 每个编辑 `{ start, end, text }` 把**原文**的半开区间 `[start, end)` 替换为
  `text`；`start === end` 时为纯插入。所有编辑基于同一原文坐标系。
- **重叠拒绝**：两个非空编辑满足 `a.start < b.end && b.start < a.end` 时抛出
  `EditOverlapError`；插入点严格落在某非空编辑内部同样拒绝。相邻区间
  （`a.end === b.start`）与区间边界上的插入是允许的，且拒绝与否与请求顺序无关。
- **同点插入按请求序**：同一位置的多个插入按请求先后依次输出（稳定排序）。
- **双向位置映射**：
  - `toNew(pos, affinity)`：原文位置 → 新文位置。严格落在被替换区间内部的
    位置按亲和绑定到该编辑输出的左 / 右边缘。
  - `toOld(pos, affinity)`：新文位置 → 原文位置。严格落在编辑输出内部的
    位置按亲和绑定到原区间的左 / 右边缘。
  - 边界位置映射到对应边界；插入点处 `left` 标记留在插入文本之前，
    `right` 标记移到其后。
- **映射复合**：删除会把整个区间折叠为一点（多对一），因此
  `toOld(q, "left" / "right")` 返回映射到 `q` 的最小 / 最大原文位置；
  凡有原像的 `q` 都满足 `toNew(toOld(q, a), a) === q`。

## 使用

```ts
import { applyEdits } from "./src/edit-map.js";

const s = applyEdits("hello world", [
  { start: 0, end: 5, text: "goodbye" }, // 替换
  { start: 6, end: 11, text: "" },       // 删除
]);
s.text;              // "goodbye "
s.toNew(8, "left");  // 8  （删除内部 → 折叠点）
s.toNew(8, "right"); // 8  （纯删除折叠为一点）
s.toOld(8, "left");  // 6  （折叠点左亲和 → 原区间左边缘）
s.toOld(8, "right"); // 11 （折叠点右亲和 → 原区间右边缘）
```

## 测试

```sh
npm test   # tsc 编译后运行 node --test
```

测试包括固定语义单测，以及对短文本的穷举核对：枚举 `{a,b}` 组成长度 ≤ 4
的全部 31 个原文、每个原文上所有 `[start, end) × {"", "x", "yz"}` 编辑，
覆盖全部 1053 个单编辑与 41067 个有序编辑对（其中 15750 个按重叠拒绝、
25317 个应用成功），逐一核对：

- 结果文本与独立的从右向左拼接实现一致；
  同点插入束保持请求序；
- 映射复合不变量：纤维（preimage）规则——`toOld(q)` 等于映射到 `q` 的
  最小（left）/ 最大（right）原文位置，且可达的 `q` 复合后回到自身；
- 删除 / 替换内部位置按左右亲和绑定边缘；
- 映射值域与 `toNew` 单调性；位置映射的子串前缀不变量。

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2（`tsc` 编译为 JS 后由
`node --test` 运行；本机 Node 构建未启用类型剥离，故先编译）。

```
ok 1 - applies replace, delete and insert on the same original
ok 2 - rejects overlapping non-empty intervals
ok 3 - rejects insertion strictly inside a replaced interval
ok 4 - allows touching intervals and boundary insertions
ok 5 - same-point insertions keep request order
ok 6 - rejects out-of-range and malformed edits
ok 7 - maps positions inside a replaced interval to edges by affinity
ok 8 - maps positions inside a pure deletion to the collapse point
ok 9 - insertion point affinity: left stays before, right moves after
ok 10 - composition round-trips and collapses as documented
ok 11 - exhaustive: every single edit on every short original
ok 12 - exhaustive: every ordered edit pair on every short original
ok 13 - exhaustive: same-point insertion bundles keep request order
ok 14 - mapping composition is consistent with substring invariants
# tests 14
# pass 14
# fail 0
# duration_ms ~1200
```
