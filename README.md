# context-patch

上下文锚定补丁库（TypeScript + Node.js 内置库，零运行时依赖）。

输入**基线**文档、**目标**文档（可能已被修改）和若干**修改区间**（基线中的
`[start, end)` 偏移 + 替换文本），在目标中按原内容及其上下文重新定位每个补丁；
定位歧义时如实报告而不猜测；整组补丁先全部校验、再原子应用；成功时输出
**逆补丁**（可 `revert` 还原目标）和**定位证据**（每个候选位置的枚举核对结果）。

## 定位策略

对每个补丁，取基线切片 `original = baseline[start:end]`：

1. `unchanged`：目标与基线一致，直接使用原区间。
2. `exact`：`original` 在目标中仅出现一次，直接定位。
3. `exact-disambiguated`：`original` 出现多次（小字符串重复场景）——
   **枚举全部出现位置**，逐一核对每个候选与基线上下文的匹配长度
   （`matchedBefore` / `matchedAfter`），仅当最优者唯一时采纳；
   并列最优则报 `ambiguous`，附全部候选，绝不猜测。
4. `context-anchored`：`original` 在目标中已不存在（内容本身被改）——
   用基线中区间前后的上下文作锚点（半径几何增长直至全文），允许锚点间
   有界间隙（`maxGap`），定位唯一才采纳，否则报 `ambiguous` / `not-found`。

多补丁：先在原目标坐标系中定位全部补丁并检查区间不重叠，任一失败则整体
不应用（原子性）；全部通过后统一应用，并按结果文档坐标生成逆补丁。

## API

```ts
import { applyPatches, revert, formatEvidence } from './src/patch';

const r = applyPatches(baseline, target, [
  { start: 15, end: 16, replacement: '2' },
]);
if (r.ok) {
  console.log(r.result);            // 打补丁后的文档
  console.log(formatEvidence(r.evidence)); // 定位证据（模式/锚点/候选枚举）
  const restored = revert(r.result, r.reverse); // 还原为 target
} else {
  for (const e of r.errors) { /* invalid-range | not-found | ambiguous | overlap */ }
}
```

## 测试

```
npm test    # tsc 编译后运行 dist/test/*.test.js（node:test）
```

环境：Node.js v22.22.1，TypeScript 7.0.2。注意：本环境未安装 `@types/node`
（无网络），`types/node-shims.d.ts` 为测试用到的 `node:test` /
`node:assert/strict` 提供最小环境声明。

### 实际测试结果（2026-10-05 记录）

```
$ npm test
# tests 15
# pass 15
# fail 0
# duration_ms ~21
```

15 个用例全部通过，覆盖：未改目标直取区间、已改目标按内容重定位、
小字符串重复时全枚举+上下文消歧、上下文完全相同的重复报歧义不猜测、
内容本身被改时锚点定位、定位失败 not-found、纯插入、多补丁原子成功、
无效区间/歧义阻断整组、重叠区间拒绝、跨偏移逆补丁还原、证据格式化输出。
