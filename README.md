# breaklines

最优段落分行库（TypeScript，零依赖）。按给定字宽表、不可断区与软断点，
在整数行宽上限内求断点序列：

- **目标**：除最后一行外，各行剩余宽度（slack）平方和最小；最后一行不罚。
- **次序**：代价相同取断点序列字典序最小者。
- **失败**：超宽不可断词返回明确的 `unbreakable-overflow`；约束不可满足
  返回 `infeasible`。
- **扩展**：浮动图片按行占可变宽度、孤行/寡行约束、全段最多 K 次断词。
  行可用宽度由前行断点形成的状态（行号 → 图片占位）决定。
- **证书**：返回最优界 `cost` 与断点证书 `breaks`、行跨度 `lines`。
- **核验**：`layoutBruteForce` 对短文本做全切分枚举，与动态规划结果对照。

## 使用

```ts
import { layout } from 'breaklines';

const r = layout({
  words: [
    { text: 'abcdef', softBreaks: [3] }, // 可在 offset 3 处断词
    { text: 'ghij', keepWithNext: true }, // 与下一词不可分行
  ],
  widths: { a: 1, b: 1, /* …每字符宽度… */ },
  spaceWidth: 1,
  hyphenWidth: 1,          // 行尾连字符宽度
  maxWidth: 10,            // 整数行宽上限
  maxHyphenations: 2,      // 全段最多 K 次断词
  images: [{ line: 1, width: 3 }], // 浮动图片：第 1 行让出 3 单位
  minFirstLineWords: 2,    // 孤行约束：首行至少 2 词
  minLastLineWords: 2,     // 寡行约束：末行至少 2 词
});

if (r.ok) {
  r.cost;   // 最优界：非末行 slack² 之和
  r.breaks; // 断点证书（afterAtom / afterWord / kind）
  r.lines;  // 行跨度：词区间、字符偏移、文本、宽度、slack、是否断词
} else if (r.kind === 'unbreakable-overflow') {
  // r.wordIndex / r.text / r.width / r.limit
}
```

## 模型

- 词按软断点切成**原子片段**（不可断区）；词内软断点处允许 `hyphen`
  断开（行尾加 `hyphenWidth`），词间允许 `space` 断开（除非
  `keepWithNext`）。
- 第 `l` 行可用宽度为 `maxWidth - reserved(l)`，`reserved` 来自浮动图片；
  因此行宽依赖由前行断点数形成的状态。
- 动态规划状态为 `(原子位置, 已用断词数, 已完成行数)`，词数 ≤ 40 时
  轻松在毫秒内求解；`layoutBruteForce` 枚举所有断点子集（≤22 个候选
  边界）用于短文本对照。

## 开发

```sh
npm test   # tsc 编译 + node --test（含 400 组随机全切分对照）
npm run build
```
