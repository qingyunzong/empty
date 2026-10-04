# stream-fragment-analyzer

增量字符流分析库（TypeScript，仅依赖 Node.js 内置模块）。在可追加、可尾部
撤销的字节流上维护**最长无重复码点片段**，片段的起止必须落在合法的词法
状态边界上，结果以**原字节区间**报告。

## 功能

- **追加 / 尾部撤销**：`append(chunk)` 接受任意字节块（多字节 UTF-8 序列
  可跨块拆分）；`undo(k)` 回退尾部 k 个码点（并丢弃尚未解码完成的挂起字
  节），窗口、词法栈与最佳候选全部通过日志精确回滚。
- **最长无重复码点片段**：唯一性按**码点**判定（组合字符如 U+0301 是独立
  码点，不按字形合并；预组合 é 与分解形式 e+◌́ 互不相同）。等长时取**开始
  最早**者。
- **词法状态边界合法**：内置词法器维护一个栈（`'` `"` `` ` `` 开闭字符串、
  字符串内 `\` 转义下一个码点）。只有栈空的位置才是合法边界，因此片段不
  会跨未闭合的引号，也不会落在转义符与被转义码点之间。
- **原字节区间输出**：`best()` 返回 `{ startByte, endByte, startIndex,
  endIndex, length }`，字节区间对应原始输入流（`endByte` 开区间）。
- **保存后继续**：`save()` 序列化全部状态（含撤销日志与挂起字节），
  `StreamAnalyzer.load(json)` 恢复后可继续追加、撤销。

## API

```ts
import { StreamAnalyzer } from "./src/analyzer";

const a = new StreamAnalyzer();
a.append(Buffer.from("中文字ab", "utf8")); // 或 a.append("中文字ab")
a.undo(1);                                  // 撤销尾部 1 个码点
const best = a.best();                      // { startByte, endByte, ... } | null
const json = a.save();                      // 保存状态
const b = StreamAnalyzer.load(json);        // 恢复并继续
```

语义约定：

- 撤销是“尾部回退”：`undo(k)` 先丢弃挂起的不完整 UTF-8 字节，再移除最多
  k 个码点，返回实际移除数。撤销后分析器始终持有原字节流的某个前缀，
  下次喂入应从 `byteLength + pendingByteCount` 处继续。
- 非法 UTF-8 字节按 U+FFFD（消费 1 字节）解码。

## 实现要点

- 滑动窗口（`left` + `lastSeen`）维护以各位置结尾的最长无重复窗口；
  每个码点一条日志记录旧 `left`、旧 `lastSeen`、旧最佳候选与词法栈操作，
  撤销 O(1)。
- 合法边界用有序数组 `normalList` 记录（边界按下标递增产生，撤销即弹
  尾），`nextNormalBoundary(left)` 二分查找 O(log n)。
- 对每个右端点 R，若 R 之后是合法边界，则候选起点为不小于 `left` 的第
  一个合法边界；全局最优即各 R 候选中的最长者（等长取开始最早）。

## 测试

```
npm test    # tsc 编译后运行 node --test
```

核对方式：

- 短字符串**全子串枚举**暴力实现（`src/brute.ts`，独立词法器）与增量结果
  逐一比对：8 符号字母表（含引号、反斜杠、组合字符、多字节字符）长度 ≤ 5
  全部 37449 个串，以及带尾部撤销的穷举。
- **随机字节切块 + 随机撤销 + 随机 save/load 续跑**，每步与“全量词法后子
  串枚举”的结果比对（5 个种子 × 500 步）。
- 手工用例覆盖：未闭合引号、转义引号、组合字符按码点计数、多字节字节区
  间、跨块拆分、长流一致性。

实际运行结果（Node v22.22.1，tsc 7.0.2）：

```
ok 1 - hand-checked basic cases
ok 2 - fragment may not cross an unclosed quote
ok 3 - fragment boundaries avoid string interiors
ok 4 - escaped quote does not close the string
ok 5 - combining characters count as code points, not graphemes
ok 6 - best fragment reports original byte range
ok 7 - byte chunks may split multi-byte sequences
ok 8 - undo restores window, lexer and best candidate
ok 9 - save and continue matches uninterrupted analysis
ok 10 - exhaustive short strings match brute force
ok 11 - exhaustive short strings with tail undo match brute force
ok 12 - random byte chunks, undos and save/load match full re-lexing
ok 13 - long stream stays consistent
# tests 13
# pass 13
# fail 0
# duration_ms ~1000
```

## 目录

- `src/utf8.ts` — UTF-8 解码（跨块不完整序列、非法字节替换）
- `src/analyzer.ts` — 增量分析器（追加 / 尾撤销 / 词法栈 / 快照）
- `src/brute.ts` — 全量词法 + 全子串枚举的独立参考实现
- `test/analyzer.test.ts` — 全部测试
