# indent-tree

面向编辑器的空格缩进语法树库：TypeScript 编写，仅依赖 Node.js 内置模块
（`node:test` / `node:assert`），支持行编辑后的增量重解析。

## 语法规则

- 仅**空格**缩进形成树；缩进更深层即成为上一行的子节点。
- 前导空白中的 **Tab 被拒绝**：该行记入错误行（Tab 不计入缩进，行仍参与
  构树，保证树总是完整）。
- **空行不改变缩进栈**，也不产生节点（只含空白甚至只含 Tab 的行同样视为
  空行；含 Tab 时仍报错）。
- 回退缩进（dedent）未落在任何外层层级上时记入错误行，并恢复为最近的
  更浅祖先的子节点，解析继续。

## 增量解析

`applyEdit(start, deleteCount, insertedLines)` 之后只重解析受影响区间：

1. 分词是行局部的，仅重新分词被替换的行；
2. 重解析从编辑点之前最后一个未变行开始，解析栈由旧解析结果精确重建
   （不能假设顶层行处栈为空——文档可能以缩进行开头）；
3. 向前解析，在遇到未变行且**弹栈前**的实时栈与旧解析栈一致时再同步，
   提前终止（在弹栈前检查，编辑引入的 dedent 错误不会被跳过）；
4. 未变行、平移行、位置对应的被替换行都**保留旧节点 ID**，只有真正
   新增的行分配新 ID；
5. 结果与全量重建**语义等同**（树结构、错误行完全一致），由随机编辑
   差分测试核对。

每次编辑返回 `EditResult`：

- `changes`：变更节点（`added` / `removed` / `updated`，含 id、行号、
  缩进、深度、父节点 id）；
- `errors`：当前全部错误行（Tab 拒绝 + dedent 不匹配）；
- `reparseRange`：实际重解析的行区间 `[start, end)`。

## 用法

```ts
import { IndentDocument } from './src/indent-tree.js';

const doc = new IndentDocument('root\n  child\n  other\n');
const result = doc.applyEdit(1, 1, ['  child-renamed']);
console.log(result.changes.updated); // [{ id: 2, content: 'child-renamed', ... }]
console.log(result.errors);          // []
console.log(doc.toJSON());           // 嵌套树（根为虚拟节点 id 0）
```

## 测试

```sh
npm test   # tsc 编译到 dist/ 后用 node --test 运行
```

前置条件：Node.js（开发于 v22）与全局可用的 `tsc`；无 npm 依赖。

## 实际测试结果

在本环境（Node v22.22.1，tsc 7.0.2）执行 `npm test` 的实际输出：

```text
> tsc -p tsconfig.json && node --test dist/test/*.test.js

ok 1 - builds a nested tree from space indentation
ok 2 - blank lines never change the indentation stack
ok 3 - tab in indentation is rejected as an error line
ok 4 - whitespace-only line containing a tab is blank but still reported
ok 5 - dedent to a non-existent level is an error line
ok 6 - an indented first line attaches to the root without error
ok 7 - content edit keeps node ids and reports one updated node
ok 8 - insertion reports added nodes and preserves ids of shifted lines
ok 9 - deletion reports removed nodes only
ok 10 - indent change ripples depth updates through following lines
ok 11 - tab errors appear and disappear with edits
ok 12 - dedent errors are maintained incrementally
ok 13 - reparse range is limited to the affected region
ok 14 - blank line insertion does not disturb the stack or ids
ok 15 - random edits keep the incremental tree equal to a full rebuild
ok 16 - error lines from random edits match the full rebuild exactly

# tests 16  # pass 16  # fail 0
```

其中测试 15/16 为随机差分测试：固定种子生成随机文档（含空行、Tab 行、
不规则缩进），施加 200 轮 × 最多 4 次随机编辑（插入/删除/替换），每次
编辑后断言：增量树与全量重建结构一致、错误行一致、编辑区间外所有行的
节点 ID 保持不变。

## 文件结构

- `src/indent-tree.ts` — 核心库（`IndentDocument`）
- `test/indent-tree.test.ts` — 全量解析规则单元测试
- `test/incremental.test.ts` — 增量编辑、变更输出、ID 保留与随机核对
- `test/node-test.d.ts` — `node:test` / `node:assert` 的最小类型声明
  （环境无 `@types/node`，不引入外部依赖）
