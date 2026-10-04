# incremental-doc-parser

一个支持增量更新的文档解析库（TypeScript，仅依赖 Node.js 内置模块）。

## 语法模型

- **标题**：`#`–`######` 开头（至多 3 个前导空格），单行节点。
- **段落**：连续的非空文本行，合并为一个节点。
- **引用链接**：`[text][label]` 与折叠形式 `[text][]`，出现在标题或段落中。
- **定义行**：`[label]: /url`，**不产生输出节点**，仅进入定义索引。
- 标签规范化：去首尾空白、压缩内部空白、转小写。
- **引用取最后一个定义**：同一标签多次定义时，链接解析到文档中最后一条定义；
  删除最后一条后自动回退到前一条。

## 增量更新

`Document.applyEdit(startLine, deleteCount, insertedLines)` 以行为单位应用编辑：

1. 更新行数组与定义索引（删除/位移/新增定义条目）。
2. 只对与编辑区域相交的节点重新解析；段落跨编辑点合并/分裂时自动扩展到相邻段落。
3. 定义的有效目标发生变化的标签记为 dirty，**只有引用了这些标签的节点**会被更新
   （同 `id`、`version` 递增、更换新对象）；其余节点保持对象同一性。
4. 所有保留节点的依赖集合（`deps`：自身行号 + 所引定义行号）随编辑位移重算，
   源区间（`startLine/endLine/startOffset/endOffset`）保持准确，
   满足 `text.slice(startOffset, endOffset) === node.text`。

`applyEdit` 返回 `EditReport`：重解析区间与本次实际更新的节点 id 列表。

## 目录结构

- `src/parser.ts` — 行分类、块解析、链接/定义提取（纯函数）
- `src/document.ts` — `Document`：全量解析 + 增量 `applyEdit`
- `test/document.test.ts` — 单元测试 + 随机编辑差分测试

## 测试

```sh
npm test   # tsc 编译后运行 node --test
```

差分测试：固定种子生成随机文档，执行 1200 次随机行编辑（插入/删除/替换 0–4 行），
每次编辑后将增量结果与全量重解析对照节点文本、源区间、链接目标与依赖集合。

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test`：

```
# tests 1
# pass 1
# fail 0
# duration_ms 1231.651817
```

（该 Node 版本将每个测试文件汇总为 1 条；文件内 7 个用例全部通过，
可直接运行 `node dist/test/document.test.js` 查看明细：）

```
random differential: 1200 edits, avg updated nodes/edit = 1.07
ok 1 - parses headings, paragraphs and reference links; definition lines produce no nodes
ok 2 - a reference resolves to the last definition of its label
ok 3 - removing the last definition falls back to the previous one
ok 4 - editing a definition updates only the nodes that reference it
ok 5 - paragraphs merge and split across line edits
ok 6 - source ranges stay accurate after insertions and deletions
ok 7 - random line edits match a full reparse (text, ranges, links, dependency sets)
# tests 7
# pass 7
# fail 0
```

另用 60 个种子 × 60 次编辑（共 3600 次）做了一次性压力验证，增量结果与全量解析全部一致。
