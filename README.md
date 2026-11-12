# 确定性校勘键（TypeScript）

本包在宿主提供的 Unicode 标量序列上执行确定性的最长规则匹配，不调用
`Intl.Collator`、系统 locale 或任何 Unicode 规范化。同一份标量序列和同一组
规则在任意机器上产生同一权重流和同一键字节。

## 规则与 CE

规则键是非空标量序列，值为零个或多个校勘元素（CE）。CE 的 `primary` 在
`0..0x1fffff`，`secondary`/`tertiary` 在 `0..65535`，`variable` 为布尔值；
`variable: true` 要求 `primary > 0`。重复规则键、空规则键和非法 CE 在构造时
抛错。

扫描时在每个标量位置选择最长完整规则。匹配可以跨 `Push` 块；块末不会提前
交付短规则，只有 `Finish` 才允许用剩余前缀排除更长规则。规则不存在时消费
一个标量并产生后备 CE：

```text
primary = 0x200000 + codePoint, secondary = tertiary = 0, variable = false
```

空扩展合法；未知标量不会被静默丢弃。扩展中的 CE 顺序保持不变。

## 使用

```ts
import { Collator, Compare, stableSortByCollation } from "./index.ts";

const rules = [
  { source: [0x61], elements: [{ primary: 10, secondary: 1, tertiary: 1, variable: false }] },
  { source: [0x61, 0x62], elements: [{ primary: 20, secondary: 2, tertiary: 2, variable: false }] },
  { source: [0x20], elements: [{ primary: 30, secondary: 0, tertiary: 0, variable: true }] },
];

// 增量导入：规则匹配跨块，前沿只保留最大规则长度所需的标量。
const collator = new Collator(rules, {
  mode: "shifted",              // 或 "non-ignorable"（默认）
  backwardSecondary: false,
  maxRuleScalars: 64,           // 可选宿主限制
  maxCEs: 100_000,              // 可选宿主 CE 预算
});
collator.push([0x61]);
collator.push([0x62, 0x20, 0x61]);
const result = collator.finish(); // Finish 成功后才能 Key
const key4 = collator.key(4);     // Uint8Array

// 完整序列比较与稳定排序。
const order = Compare([0x61], [0x62], { rules }, 4);
const sorted = stableSortByCollation(
  [{ id: 1, text: [0x61] }, { id: 2, text: [0x62] }],
  (item) => item.text,
  { rules },
  4,
);
```

构造器也接受 `new Collator({ rules, mode: "shifted" })`、规则元组数组
`[source, elements][]`、`Map` 或字符串键对象。字符串输入按 Unicode 码点解析，
孤立代理项会被拒绝；宿主仍应负责规范化和提供标量序列。

## 权重与键

`finish()` 返回 `CollationResult`：

- `result.levels`：四个数字权重流。
- `result.weights`：四组 `WeightRecord`，每个记录包含 `value`、`level`、
  来源标量半开区间 `source.start..source.end` 和扩展 CE 序号
  `source.expansionIndex`（也提供 `sourceStart`/`sourceEnd`/`expansionIndex`
  快捷字段）。
- `result.streams` / `result.provenance`：上述两者的别名。

`non-ignorable` 模式把每个 CE 的非零 primary/secondary/tertiary 分别加入前三
级，第四级为空。`shifted` 模式中：

- variable CE 只把自身 primary 加入第四级，并开启抑制。
- 抑制期间 primary 为 0 的 CE 整项忽略，不产生任何级或来源记录。
- 抑制由下一条非 variable 且 primary > 0 的 CE 关闭；该 CE 正常进入前三
  级，并在第四级追加 `0x400000`。
- 非抑制状态下 primary 为 0 的重音仍保留非零 secondary/tertiary，第四级不
  加标记。

抑制状态跨块、跨一条规则内的多个扩展 CE 持续存在。`backwardSecondary:
true` 在完整文本结束后只反转第二级全部权重，来源记录随权重一起移动。

`key(strength)`（别名 `Key`/`getKey`）返回前 `1..4` 级：每个非零权重编码为
4 字节无符号大端，每级末尾追加 4 个零字节。零权重从不写入。无符号字节字典
序与逐级权重比较一致；较低强度相等时直接返回相等，不用原文或更低级权重
决胜。

## 错误与限制

- 非法标量：`InvalidScalarError`。
- 重复/空规则、非法 CE：`DuplicateRuleError`、`InvalidRuleError`。
- `Finish` 前 `Key`：`NotFinishedError`。
- 重复 `Finish`：`AlreadyFinishedError`。
- 完成后 `Push`：`PushAfterFinishError`。
- 规则超过 `maxRuleScalars`：`RuleLimitExceededError`。
- 生成 CE 超过 `maxCEs`：`BudgetExceededError`（在扩展时计入，包含后备 CE
  和被抑制的 CE）。

## 测试

`npm test` 先用 TypeScript 编译，再运行 `node:test`。测试包含独立的一次性
最长规则参考实现，覆盖所有标量切块、短规则为长规则前缀、多字符收缩、单字符
扩展、跨块 variable 抑制、全可忽略文本、补充平面码点、四种强度、
`backwardSecondary` 来源移动，以及小字母表短文本的穷举 `Compare`/键字节/
相等关系/稳定排序核对。
