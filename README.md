# preview-parser

TypeScript 预览解析库：只支持 `p`、`b`、`i`、`br` 四种标签和文本，仅使用
Node.js 内置模块（运行时零依赖，测试基于 `node:test` / `node:assert`）。

## 解析规则

- **支持的标签**：`p`、`b`、`i`、`br`（`br` 为空元素；`/>` 自闭合对任意
  支持的标签生效）。标签属性被忽略。其他标签一律忽略并报告
  `unsupported-tag` 诊断。
- **隐式闭合**：`<p>` 内出现新的 `<p>` 时，旧的 `<p>`（以及它内部未闭合
  的元素）被隐式闭合，不产生诊断。输入结束时仍未闭合的元素同样隐式
  闭合。
- **闭合不存在的标签**：忽略并报告 `unmatched-close` 诊断；若闭合的是
  外层已打开的标签，其内部元素隐式闭合。
- **未终结的标签**：输入结束时出现不完整的 `<...`，按字面文本处理并报告
  `unterminated-tag` 诊断。`<` 后接非字母非 `/` 的字符时按字面文本处理。
- **实体解码**：支持 `&amp;` `&lt;` `&gt;` `&quot;` `&apos;` `&nbsp;`
  以及十进制 `&#65;` / 十六进制 `&#x41;` 数字实体；未知实体保留字面
  文本。文本节点保留原始字节映射：`start`/`end` 是原始输入中的偏移
  （UTF-16 码元下标），`entities[]` 记录每个解码实体的原始区间与解码
  结果。
- **诊断顺序**：诊断按源代码偏移顺序产生，与输入如何分块无关。

## 增量输入

`Parser` 以事件流为核心（`open` / `close` / `text` / `diagnostic`），
树由事件流独立构建（`buildTree`）。无论输入一次性给出还是按任意块
边界切分（包括标签、实体被切块边界劈开的情况），产出的事件流、树和
诊断顺序完全一致——测试对语料中每个输入枚举了所有二切分、定长切块
和随机切块进行核对。

## 用法

```ts
import { Parser, buildTree, parse, parseChunks } from "./src/index.js";

// 一次性解析
const { root, diagnostics, events } = parse("<p>one<p>two &amp; three");

// 增量解析
const parser = new Parser();
parser.feed("<p>Hel");
parser.feed("lo &am");
parser.feed("p;world");
const events2 = parser.end();
const { root: root2, diagnostics: diags2 } = buildTree(events2);
```

## 测试

```sh
npm test        # tsc 编译后运行 node:test 测试
npm run typecheck
```

## 实际测试结果

在 Node.js v22.22.1、TypeScript 7.0.2 环境下执行 `npm test`
（`tsc -p tsconfig.json && node dist/test/parser.test.js`），实际输出
摘要：

```
1..18
# tests 18
# suites 0
# pass 18
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 51.618219
```

18 个测试全部通过（退出码 0），覆盖：基本树结构、`p` 隐式闭合（含嵌套
元素）、闭合不存在标签的忽略与报告、不支持标签的诊断、`<br>` 与自闭
合、实体解码与原始字节映射（含数字实体、未知实体、多字节字符）、属性
忽略、未终结标签、EOF 隐式闭合、诊断顺序，以及 18 组语料在全二切分 /
定长切块 / 随机切块下与一次性解析的事件流、树、诊断完全一致。
