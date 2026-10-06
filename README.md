# script-splitter

按**顶层分号**切分脚本的 TypeScript 库。以下结构内部的分号不会触发切分：

- 单引号 / 双引号字符串（支持 `''`/`""` 双写转义与 `\` 反斜杠转义）
- 行注释（`-- ...` 与 `// ...`，到换行为止）
- 块注释（`/* ... */`）
- 模板字符串（`` `...` ``），包括 `${ ... }` 模板插值；插值内可嵌套括号、
  花括号、字符串、注释以及更深层模板

## 用法

```ts
import { splitStatements, StatementSplitter } from "./src/splitter.js";

// 整串解析
const statements = splitStatements("select 1; select ';';");
// => [{ text: "select 1;", start: 0, end: 9 },
//     { text: " select ';';", start: 9, end: 21 }]

// 增量解析（任意切块喂入，结果与整串解析一致）
const splitter = new StatementSplitter();
for (const ch of script) splitter.write(ch);
const same = splitter.end();
```

- 每句保留原文跨度：`text === script.slice(start, end)`，分号包含在句内。
- 仅含空白/注释的空语句会被跳过；脚本末尾无分号的残余语句也会保留。
- 未闭合结构（字符串、块注释、模板、插值）抛出 `UnclosedConstructError`，
  其 `position` 为**最内层**未闭合结构的起始位置（`index`/`line`/`column`）。

## 切块一致性核验

`splitStatementsChunked(script, chunkSizes)` 按给定块长序列喂入增量解析器。
测试对综合脚本枚举了**所有**块长（1..N，含逐字符）以及 200 组随机切块，
逐一断言与整串解析结果完全一致；未闭合报错位置也做了逐字符切块比对。

实现要点：解析器是基于栈的增量状态机；当缓冲区末尾的字符需要前瞻下一个
字符才能判定（`--`、`//`、`/*`、`*/`、`${`、`''`、`\"`、`\` 转义）时，
该字符会延迟到下一数据块到达（或 `end()`）时再处理，因此切块边界不影响结果。

## 测试

```sh
npm test   # tsc 编译后运行 node:test 测试
```
