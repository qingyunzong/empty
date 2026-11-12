# 响应式图片候选还原

这个包按照题面给定的确定性规则，复现一个采集到的 `<picture>` 在指定视口和 DPR 下选择哪条资源。它不会访问网络，也不会模拟浏览器的节流、缓存或加载失败重试。

核心入口：

```ts
import {
  Rational,
  selectPicture,
  parseSrcset,
  evaluateSizeExpression,
} from "./index.js";
```

`selectImageCandidate` 是 `selectPicture` 的同义导出。

## 构建与测试

```bash
npm run typecheck
npm test
```

`npm test` 会先用 `tsc` 生成 `dist/`，然后运行 `node --test`。源码导入使用 NodeNext 风格的 `.js` 扩展名，发布入口为 `dist/index.js`。

## 基本调用

```ts
const result = selectPicture({
  sources: [
    {
      media: "(min-width: 700px)",
      type: "image/webp",
      srcset: "wide.webp 1x, wide@2x.webp 2x",
      sizes: [{ media: "(min-width: 900px)", expression: "50vw" }],
    },
  ],
  img: {
    srcset: "fallback.png 2x",
    src: "fallback.png",
    sizes: [{ expression: "100vw" }],
  },
  baseUrl: "https://cdn.example.test/pictures/",
  viewportWidth: Rational.from("800"),
  dpr: Rational.from("2"),
  mediaMatches: (media, context) => {
    // 宿主自己的确定性媒体条件判断；context.viewportWidth 是精确有理数。
    return media === "" || media.includes("700") || media.includes("900");
  },
  supportsType: (mimeType) => mimeType === "image/webp",
});

if (result.selected) {
  result.url;                   // 规范化后的绝对 URL
  result.density.toString();    // 精确有理数，例如 "2" 或 "8/5"
  result.densityNumber;         // 方便展示的近似 number
  result.sourceIndex;           // 命中的 source 下标；img 为 null
  result.sizesIndex;            // 命中的 sizes 条目下标；未命中或 x 集为 null
  result.candidate.range;       // start/end 与 byteStart/byteEnd
}
```

`examples/host.ts` 提供了一个更完整的采集宿主适配器，包括 `(min-width: Npx)` / `(max-width: Npx)` 的确定性判断和 MIME 白名单。

## 输入

`selectPicture` 接收：

- `sources`: 有序的 `{ srcset, media?, type?, sizes? }` 列表。
- `img`: 最后的 `{ srcset?, src?, sizes? }`。
- `baseUrl`: 绝对 URL，用于解析所有相对候选 URL。
- `viewportWidth`, `dpr`: 正有理数。可以是 `Rational`、number、十进制字符串或 `{ numerator, denominator }`。
- `mediaMatches(media, context)`: 宿主确定性媒体回调。
- `supportsType(mimeType, context)`: 宿主确定性 MIME 支持回调。

`media` 或 `type` 省略时视为成立/支持；存在时完全由回调决定。`sizes` 是 `{ media?, expression }` 的有序列表，不是 CSS 原文。

## 选择规则

1. 按 `source` 顺序，只考虑 `media` 成立且 `type` 支持的 source。
2. source 的候选集为空、所有候选都无效、或同时混有有效 `w` 与 `x` 候选时，该 source 不可用，继续下一个。
3. 没有可用 source 时使用 `img`。
4. 仅 `img`：若有效候选集没有 `w` 且没有 `1x`，将非空 `src` 追加为 `1x` 候选。追加后仍为空的集合不可用。
5. `w` 集通过 sizes 求槽宽：取首个 `media` 成立且表达式为正的条目；都不成立时使用视口宽。
6. 候选密度为 `w / slot` 或 `x`。选择最小的 `>= DPR` 密度；若没有，则选择最大密度。密度并列保留原顺序。

## srcset 扫描

- 跳过 ASCII 空白与逗号后开始一个候选。
- URL 一直取到 ASCII 空白，因此 URL 内部逗号不会成为分隔符，data URL 不会被拆坏。
- URL token 以逗号结尾时，去掉全部尾逗号，作为无描述符的 `1x` 候选。
- 否则 URL 后的内容按 ASCII 空白切分描述符，到第一个逗号结束本候选。
- 只接受一个无符号正十进制整数 `w`，或无符号正有限十进制 `x`（整数，或小数点两侧都有数字；不支持指数）。
- 无描述符为 `1x`。其他、多个、非正描述符只丢弃本候选，记录 `range`、`raw`、`reason`，继续扫描。
- 同类型同数值的重复描述符只保留最早候选。
- URL 用 `new URL(url, baseUrl)` 解析；失败只丢弃本候选。

候选范围约定：

- `range.start` / `range.end` 是原字符串的 UTF-16 半开区间。
- `range.byteStart` / `range.byteEnd` 是同一区间的 UTF-8 字节偏移。
- 对 srcset 候选，范围不包括候选之间的分隔逗号，但包括 URL token 末尾被剥离的逗号。
- 由 `img.src` 追加的候选，其范围相对于 `src` 属性本身，`origin` 为 `"src"`。

独立的 `parseSrcset(srcset, baseUrl)` 可直接得到 `{ candidates, discarded, issue }`。

## sizes 表达式

`evaluateSizeExpression(expression, viewportWidth)` 和 `selectSlotWidth(entries, viewportWidth, mediaMatches)` 可独立使用。

表达式只允许：

- 非负有限十进制 `px` 或 `vw` 长度；十进制语法与 `x` 描述符相同。
- 括号、二元 `+` / `-`，同级左结合，不支持一元符号。
- `min(...)` / `max(...)`，每个函数至少两个参数，可嵌套。

乘除、指数、其他单位和函数一律拒绝。所有运算使用精确有理数；中间长度可为负，但表达式最终必须为正。`vw` 按视口宽的百分比精确计算。

## 结果

成功后返回 `selected`，并带有便于检查的顶层别名：

- `url`、`density`、`densityText`、`densityNumber`
- `source` (`"source"` / `"img"`)、`sourceIndex`、`sizesIndex`
- `candidate`、`adopted`
- `discarded`（选中候选集内的丢弃记录）、`discardedAll`（本次选择所有已评估候选集的丢弃记录）、`candidateSet`、`trace`

`candidateSet` 包含全部有效候选、丢弃记录和集合级问题（空集或 `w`/`x` 混用）。`trace` 记录每个 source 以及最终 img 的媒体、MIME 和候选集判断过程。

失败时返回 `selected: null` 和确定的 `reason`，不会抓取网络。
