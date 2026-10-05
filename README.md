# replace-map

一个 TypeScript 替换库：按给定的非重叠匹配与捕获区间展开 `$` 引用模板，
并输出替换后文本到原文的映射。仅使用 Node.js 内置模块，零运行时依赖。

## 功能

- **模板展开**：`$$`（字面 `$`）、`$&`/`$0`（整体匹配）、`$1`–`$99`（捕获组）。
- **无效引用拒绝整次操作**：捕获下标越界、组未参与匹配、`$` 后接非法字符，
  均抛出 `InvalidCaptureError`，调用方状态不被修改（原子性）。
- **零长度匹配推进一个码点**：`findMatches` 在空匹配后按码点（而非码元）
  前进，不会劈开代理对，也不会死循环。
- **输出到原文映射**：`SourceMap` 由若干区段组成；插入内容 `src = null`（无源），
  复制内容记录源区间。
- **逆查询返回全部输出区间**：捕获复制造成一源多输出，
  `outputRangesForSource(pos)` 返回所有包含该源位置的输出区段（极大同源复制段）。
- **多轮复合**：`SourceMap.compose` 把各轮映射复合为当前文本直达原文的映射。
- **快照与撤回**：`ReplaceSession` 每轮绑定前快照，`rollback()` 逐轮撤回。
- **预算限制**：`budget` 限制展开后输出长度，超限抛 `BudgetExceededError`，
  会话保持不变。

## 使用

```ts
import { ReplaceSession, findMatches } from "./src/index.js";

const session = new ReplaceSession("John Smith");
session.apply(
  [{ start: 0, end: 10,
     captures: [undefined, { start: 0, end: 4 }, { start: 5, end: 10 }] }],
  "$2, $1",
);
session.text;                    // "Smith, John"
session.sourcePositionAt(0);     // 5（'S' 来自原文 5）
session.sourcePositionAt(5);     // null（',' 为插入内容，无源）
session.outputRangesForSource(0);// [{ start: 7, end: 11 }]（"John" 的所有输出区间）
session.rollback();              // 回到 "John Smith"

// 正则查找（自动处理零长度匹配的码点推进）
const matches = findMatches("😀x", /a*/); // 空匹配在 0、2、3，不落在代理对中间
```

## 测试

```sh
npm test   # tsc 编译 + node --test
```

测试包含确定性用例，以及两类随机对照（固定种子，可复现）：

- **逐段解释器对照**：`src/reference.ts` 是独立的逐段朴素解释器，
  随机小文本（含代理对字符）上单轮替换的文本与逐码元源标签须与主实现一致。
- **三轮标签传播核对**：随机三轮替换，直接逐码元传播来源标签，
  与 `ReplaceSession` 复合映射的正向/逆向查询逐一比对。

## 实测结果（2026-10-06，Node v22.22.1，tsc 7.0.2）

```
# tests 5  (5 个测试文件，共 20 个用例)
# pass 5
# fail 0
```

- map.test.js: 2 通过（一源多输出区间、跨轮复合与插入无源）
- random.test.js: 4 通过（单轮对照、三轮标签传播、无效引用原子拒绝、预算失败不修改）
- replace.test.js: 8 通过（基本映射、捕获乱序展开、零长度插入、非法引用/重叠匹配拒绝、
  预算原子性、码点推进、捕获区间与未参与组）
- session.test.js: 3 通过（逐轮快照撤回、失败轮次不修改、撤回后映射还原）
- template.test.js: 4 通过（字面量与引用解析、`$$`/`$&`/`$0`、两位数字贪婪解析、畸形引用拒绝）
