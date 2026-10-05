# incremental-doc-parser

基于行的增量文档解析库（TypeScript + Node.js 内置库，零第三方依赖）。

## 解析规则

- **标题**：`# ` 至 `###### ` 的 ATX 标题（单行块）。
- **段落**：连续的普通文本行（空行、标题行、定义行会打断段落）。
- **引用链接**：`[text][id]` 与折叠形式 `[id][]`；id 归一化（去首尾空白、压缩内部空白、小写）。
- **定义**：`[id]: url "可选标题"` 独立成行；**定义行不产生输出节点**。
- **引用解析**：同一 id 有多个定义时，引用取**最后一个**定义；无定义时链接无 `url`。

## 增量更新

`Document#applyEdit(startLine, deleteCount, newLines)` 以行为单位编辑：

- 仅重解析受编辑影响的最小区块范围（自动向块边界扩展，并处理跨编辑点的段落合并/拆分），后续未受影响的块整体复用，仅平移行号。
- 定义表按 id 维护（按行号有序）；编辑后仅当某 id 的**活动定义**（最后一个）发生变化时，才通过依赖索引（定义 id → 引用节点集合）重新解析**引用该 id 的节点**，其余节点不动。
- 节点的源区间（`start`/`end` 字符偏移与行号）在每次编辑后保持准确：`text === source.slice(start, end)`。
- 返回 `EditResult`：`updatedNodeIds`（重建或重解析的节点）、`removedNodeIds`、`reparsedLines`、`changedDefinitions`。

## API 摘要

```ts
import { Document } from './src/document.js';

const doc = new Document('# T\n\nsee [x][a]\n\n[a]: https://a1');
doc.getNodes();                 // 输出节点（标题/段落，含 refs 与已解析 links）
doc.getDefinitions();           // 每个 id 的活动（最后）定义
doc.getDependencies();          // 定义 id -> 引用它的节点 id 集合
const r = doc.applyEdit(4, 1, ['[a]: https://a2']);
// r.updatedNodeIds 只包含引用 [a] 的段落节点
```

## 测试

```
npm test    # tsc 编译后运行 node:test 套件
```

- `test/document.test.ts`：13 个单元测试，覆盖标题/段落/定义解析、最后定义优先、定义行不输出、改定义只更新引用节点、影子定义不触发更新、删除定义回退/失效、区间准确性、段落合并拆分、依赖集合。
- `test/random.test.ts`：4 个种子 × 每种子 250 次随机行编辑，每次编辑后将增量状态与从头全量解析对照：节点文本、源区间、引用解析结果、定义表、依赖集合完全一致。

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
$ npm test
ok 1 - dist/test/document.test.js
ok 2 - dist/test/random.test.js
# tests 2
# pass 2
# fail 0
```

逐条用例（`node dist/test/*.test.js`）：

```
ok 1 - parses headings and paragraphs; definition lines are not output
ok 2 - a reference resolves to the LAST definition of its id
ok 3 - collapsed reference [id][] uses the text as id; ids are case-insensitive
ok 4 - unresolved references have no url
ok 5 - source ranges slice back the exact node text
ok 6 - editing a definition updates only its referencing nodes
ok 7 - editing a shadowed (non-last) definition changes nothing
ok 8 - deleting the last definition falls back to the previous one
ok 9 - deleting the only definition makes the reference unresolved
ok 10 - inserting lines above keeps source ranges accurate
ok 11 - removing the blank line between two paragraphs merges them
ok 12 - splitting a paragraph with a blank line yields two paragraphs
ok 13 - dependencies map tracks referencing nodes per definition id
ok 1..4 - random line edits match a full re-parse (seeds 1, 7, 42, 2026)
```

另做一次性压力验证（未纳入套件）：50 个种子 × 300 次随机编辑共 15000 次，增量结果与全量解析全部一致。

## 已知简化

- 不支持行内链接 `[t](url)`、图片、围栏代码块；`![alt][id]` 会按普通引用处理。
- 定义仅支持单行形式 `[id]: url "title"`（含 `'` 与 `()` 标题写法）。
