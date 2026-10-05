# preview-parser

增量预览解析库。TypeScript 编写，仅依赖 Node.js 内置模块（`node:test` / `node:assert`），无第三方运行时依赖。

## 解析规则

- 只支持元素 `p`、`b`、`i`、`br` 与文本；`br` 是空元素。
- `p` 内出现新的 `<p>` 时隐式结束旧的 `p`（不记诊断）；其上的内联元素记 `implicit-close`。
- 闭合不存在的标签：忽略并报告 `unmatched-close`。
- 闭合非栈顶元素时，其上的元素隐式关闭并报告 `implicit-close`。
- 不支持的标签（如 `<div>`）：忽略并报告 `unknown-tag`。
- 非空元素上的自闭合斜杠（如 `<p/>`）按 HTML5 惯例忽略。
- 输入结束时未闭合的元素按弹栈顺序（自内向外）报告 `unclosed-tag`。
- 未终止 / 畸形标签按字面文本处理并报告 `malformed-tag`；裸露的 `<`、`&` 按字面文本处理。
- 实体解码支持 `&amp; &lt; &gt; &quot; &apos;` 与十进制 / 十六进制数字实体；
  未知或非法实体保留字面文本并报告 `unknown-entity`。
- 诊断按源码顺序产生（`unclosed-tag` 在输入末尾追加）。

## 实体解码的原始偏移映射

每个文本节点携带 `segments: { text, start, end }[]`：按顺序拼接 `text` 即解码后文本，
`[start, end)` 是该片段在原始输入中的偏移（UTF-16 码元下标，ASCII 输入下等同于字节偏移）。
实体如 `&amp;` 解码为 `&`，其 segment 仍指向 `&amp;` 的原始范围。

## 增量输入与事件规则

- `Parser.write(chunk)` 接受任意切分的字符串块，`end()` 结束解析。
- 词法层（`Tokenizer`）产出独立的事件流（`text` / `open` / `close`），不施加结构规则；
  树构建规则全部在 `TreeBuilder` 中。文本事件是极大的（只在标签边界或输入结束时产出），
  因此**同一输入无论怎么分块，事件流、树与诊断顺序完全一致**（有测试保证）。

## API

```ts
import { Parser, parse } from 'preview-parser';

// 一次性解析
const { root, diagnostics, events } = parse('<p>one<p>two &amp; three</p>');

// 增量解析
const parser = new Parser();
parser.write('<p>Hel').write('lo</p>');
const result = parser.end();
```

## 目录结构

- `src/types.ts` — 事件、诊断、节点等公共类型
- `src/tokenizer.ts` — 增量词法器（标签、文本、实体解码与偏移映射）
- `src/tree.ts` — 树构建器（结构规则与树层诊断）
- `src/parser.ts` — `Parser` / `parse` 组合入口
- `test/parser.test.ts` — 基于 `node:test` 的测试

## 测试

```sh
npm test   # tsc 编译（严格模式）后用 node --test 运行 dist/test/*.test.js
```

### 实际运行结果（2026-10-06，Node.js v22.22.1，tsc 7.0.2）

`npm test` 输出：

```
> preview-parser@0.1.0 test
> tsc -p tsconfig.json && node --test dist/test/*.test.js

TAP version 13
# Subtest: dist/test/parser.test.js
ok 1 - dist/test/parser.test.js
1..1
# tests 1
# pass 1
# fail 0
```

测试文件内 18 个子测试全部通过（`node dist/test/parser.test.js` 明细）：

```
ok 1 - 基本标签构建树
ok 2 - p 内的新 p 隐式结束旧的 p
ok 3 - 新 p 隐式结束旧 p 时，其中的内联元素记 implicit-close
ok 4 - 闭合不存在的标签被忽略并报告 unmatched-close
ok 5 - 闭合非栈顶元素时，其上的元素隐式关闭
ok 6 - 不支持的标签被忽略并报告 unknown-tag
ok 7 - br 是空元素，不需要闭合
ok 8 - 非空元素上的自闭合斜杠被忽略
ok 9 - 实体解码保留原始偏移映射
ok 10 - 支持全部命名实体与十六进制数字实体
ok 11 - 未知实体保留字面文本并报告 unknown-entity
ok 12 - 裸露的 < 和 & 按字面文本处理
ok 13 - 输入末尾未终止的标签按字面文本处理并报告 malformed-tag
ok 14 - 输入结束时未闭合的元素按弹栈顺序报告 unclosed-tag
ok 15 - 诊断按源码顺序报告
ok 16 - 事件流独立于树规则，只描述词法内容
ok 17 - 标签与实体跨块拆分结果一致
ok 18 - 增量分块与整体解析的事件流、树、诊断完全一致
# tests 18
# pass 18
# fail 0
```
