# doc-index

增量文档索引库（TypeScript）：从 Markdown 风格文档中提取**标题**、**显式锚点**和**内部引用**，忽略代码围栏（``` / ~~~）内的内容。

## 规则

- **标题**：ATX 风格 `#`–`######`（前导空格 ≤ 3，可带闭合 `#`）。
- **标题 ID**：ASCII 字母小写，空白折叠为单个 `-`（`slugify`）；重复标题按文档顺序追加序号：`intro`、`intro-1`、`intro-2`…
- **锚点**：`<a name="...">` / `<a id="...">`。
- **引用**：`[text](#target)`。引用**可前向**——解析在整篇文档扫描完成后进行，指向后文定义的锚点同样有效；`resolved` 标记目标是否存在。
- **围栏**：``` 或 ~~~ 围栏内的标题/锚点/引用全部忽略；闭合围栏需同字符、长度 ≥ 起始、无 info 串；未闭合围栏吞掉文档剩余部分。

## 增量编辑

`edit(startLine, deleteCount, inserted)` 替换局部行后，只重扫编辑区及围栏状态重新收敛所需的后续行（围栏可跨越编辑区），得到的 `snapshot()` 与对新文本全量扫描（`DocumentIndex.fromText`）**完全一致**——由随机差分测试保证。

```ts
import { DocumentIndex } from "./src/index.ts";

const idx = DocumentIndex.fromText("# Hello World\n[fwd](#later)\n# Later\n");
idx.headings;            // [{ line: 0, level: 1, text: "Hello World", id: "hello-world" }, ...]
idx.references[0];       // { line: 1, text: "fwd", target: "later", resolved: true }

idx.edit(0, 0, ["```"]); // 在第 0 行前插入围栏起始行
idx.headings;            // 两个标题均被围栏隐藏
```

## API

- `new DocumentIndex(text)` / `DocumentIndex.fromText(text)`
- `edit(startLine, deleteCount, inserted: string[] | string)` — 0 起始行号；`inserted` 可为行数组或 `\n` 分隔字符串；CRLF 自动归一
- `snapshot()` → `{ headings, anchors, references }`（带缓存，编辑后失效重建）
- `headings` / `anchors` / `references` / `getText()` / `lineCount`

## 测试

```sh
npm test        # tsc 编译到 dist/ 后用 node:test 运行
npm run typecheck
```

测试覆盖：slug 生成与去重、围栏状态机、锚点/引用提取、增量编辑（含围栏跨编辑区、开合围栏改变后续可见性、重复编号漂移），以及 150 组随机文档 × 25 次随机编辑与全量扫描的差分对比。
