# linebreak-layout

按字宽表、不可断区与软断点对段落做**最优分行**的 TypeScript 库。

- 行宽上限为正整数；**最后一行不罚**，目标为其余各行剩余宽度平方和最小。
- 同费用时取**断点序列字典序最小**者。
- 输出每行跨度（词下标 / 片段下标 / 字符偏移）、最优界与断点证书。
- 超宽不可断词**明确失败**；短文本可用全切分参考实现对照核验。
- 扩展：浮动图片占行宽（逐行可变）、孤行寡行约束、最多 K 次断词、
  行宽依赖前行断点状态（连字符携带惩罚）。

## 模型

- 输入为词序列。词内 `U+00AD`（软连字符）为合法断词点；`glueAfter`
  （或文本中的 `U+00A0`）把相邻词粘成不可断区。
- 字宽表给出每个字符（含 `' '` 与 `'-'`）的宽度，行内词间计一个空格宽，
  断词行尾计一个连字符宽。建议使用整数宽度以保证同费用判定精确。
- 第 `i` 行可用宽度 = `lineWidth` − 该行浮动图片占用 −
  （前行以连字符结尾时）`hyphenCarryWidth`。行号与前行断点类型构成
  DP 状态，即“行宽依前行断点形成状态”。
- 约束：每行（含末行）宽度 ≤ 可用宽度；断词次数 ≤ `maxHyphenations`；
  `minLastLineWords` 限制末行最少词数（单行段落豁免）；
  `pageHeight`/`minLinesAtPageEdge`/`startLineOffset` 实现按页孤行寡行
  控制（任一页上的段落行数不得少于阈值，除非段落起止于该页）。

## 用法

```ts
import { layoutText, solveLayout, verifyCertificate, solveBruteForce, uniformWidths } from "linebreak-layout";

const result = solveLayout({
  words: [{ text: "ab­cd" }, { text: "ef" }],   // ­ 为软断点
  widths: uniformWidths("abcdef", 1),            // 字宽表
  lineWidth: 3,
  maxHyphenations: 2,                            // 最多 K 次断词
  floats: [{ startLine: 0, lineCount: 1, width: [1] }], // 浮动图片
  hyphenCarryWidth: 1,                           // 前行断词 → 本行减宽
  pageHeight: 4, minLinesAtPageEdge: 2,          // 孤行寡行
  minLastLineWords: 2,
});

if (result.ok) {
  result.bound;                  // 最优界（其余行剩余宽平方和的最小值）
  result.certificate.breakpoints; // 断点序列（片段边界下标）
  result.certificate.lines;       // 每行跨度：词/片段/字符范围、宽度、剩余、罚值
  verifyCertificate(input, result.certificate).valid; // 证书重放核验 === true
} else {
  result.reason; // 明确失败原因
}
```

`layoutText({ text, ... })` 可直接处理纯文本（空格分词，`U+00A0` 粘连，
`U+00AD` 软断点）。

## 失败模式（`ok: false`）

- `missing-char-width`：字宽表缺字符（含 `' '` / `'-'`）。
- `empty-word` / `malformed-soft-break`：空词或软断点位置非法。
- `unbreakable-word-too-wide`：无软断点的词超过行宽上限（附词与宽度）。
- `unbreakable-fragment-too-wide`：断词后最小片段仍超宽。
- `no-feasible-layout`：约束（浮动图片 / K / 孤行寡行 / 粘连）下无可行切分。

## 正确性核验

- `verifyCertificate(input, cert)`：重放断点证书，检查断点合法、每行
  不超可用宽、K/孤行寡行/末行词数约束成立、重算费用与证书一致。
- `solveBruteForce(input)`：全切分参考实现（枚举全部断点集合，同一目标
  与决胜规则），供短文本对照；测试中 400 组随机短文本与 DP 求解器
  逐一比对最优界与断点序列。

## 复杂度

DP 状态为 `(片段位置, 行号, 已用断词数, 前行是否断词)`，复杂度约
`O(F² · L · K)`（F 为片段数，L 为行数），面向 ≤ 40 词的段落。

## 构建与测试

```sh
npm test   # tsc 编译后运行 node --test（无需安装依赖）
npm run build
```
