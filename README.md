# indent-syntax-tree

编辑器风格的缩进语法树库：TypeScript 编写，仅使用 Node.js 内置模块
（`node:test` / `node:assert`），无任何运行时依赖。

## 解析规则

- 仅按**前导空格**缩进构建树；子节点缩进必须大于父节点。
- 含 **Tab 的行被拒绝**：记入错误行列表，且不参与树的构建（不影响缩进栈）。
- **空行**（空或仅含空格）被跳过，**不改变缩进栈**。

## 增量重解析

`IndentDocument.applyEdit(start, deleteCount, inserted)` 按行替换文档内容，
只重解析受影响区间：

- 从编辑点前最近节点的祖先链重建解析栈，无需从头解析。
- 越过编辑范围后，一旦解析栈与旧树完全同步（逐层 id 匹配），立即停止，
  其余旧子树整体保留（仅行号平移）。
- **旧节点 ID 尽量保留**：编辑点之前的节点不变；编辑块内 (indent, content)
  相同的行回收旧 id；编辑点之后的节点保留 id（仅行号变化）。
- 结果与完整重建**语义等同**（随机编辑测试逐次核对树结构与错误行）。

返回值 `EditResult`：

- `changes`：变更节点列表，`added` / `removed` / `changed`
  （`changed` 表示 id 保留但父节点改变，即节点移动；纯行号平移不上报）。
- `errors`：新文档中的 Tab 错误行（0 起始行号）。
- `reparsed`：实际重解析的行区间（新文档行号，半开区间）。

## API

```ts
import { IndentDocument, parse, structureOf, formatTree } from "./src/parser.js";

const doc = new IndentDocument("root\n  child\n\tbad line\n");
doc.getErrors();          // [2] —— Tab 行
formatTree(doc.root);     // 可读树形输出

const res = doc.applyEdit(1, 1, ["  child", "    grand"]); // 行编辑
res.changes;              // 变更节点（added/removed/changed）
res.errors;               // 最新错误行
res.reparsed;             // 实际重解析区间

parse(text);              // 一次性完整解析（用于对照）
```

## 构建与测试

需要 Node.js（≥18）与全局可用的 `tsc`（TypeScript 编译器）。

```sh
npm test    # tsc 编译到 dist/ 后用 node --test 运行
```

测试覆盖：缩进建树、Tab 拒绝、空行不影响栈、多级 dedent、增量区间
重解析、编辑块内 id 保留、节点移动上报、错误行平移，以及**随机编辑
核对**（60 种子 × 40 次编辑：每次编辑后增量树与完整重建的结构、
错误行完全一致，并校验变更集与 id 映射一致）。

## 实际测试结果

`npm test` 输出（TAP）：

```
> indent-syntax-tree@0.1.0 test
> tsc -p tsconfig.json && node --test dist/test/*.test.js

TAP version 13
# Subtest: dist/test/parser.test.js
ok 1 - dist/test/parser.test.js
  ---
  duration_ms: 304.653683
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 317.94267
```

测试文件内 11 个用例全部通过（`node dist/test/parser.test.js` 明细）：

```
ok 1 - builds a tree from space indentation
ok 2 - rejects tabs: error lines reported and excluded from the tree
ok 3 - blank lines do not change the indentation stack
ok 4 - dedent pops multiple levels at once
ok 5 - incremental edit reparses only the affected interval
ok 6 - ids are preserved for unchanged lines inside an edited hunk
ok 7 - moving a node to a new parent is reported as changed, id kept
ok 8 - error lines shift with edits and are recomputed in the edited range
ok 9 - deleting a parent re-parents or removes its subtree like a full rebuild
ok 10 - formatTree renders a readable dump
ok 11 - randomized edits: incremental result equals full rebuild
# tests 11 / # pass 11 / # fail 0
```

随机核对统计（测试内打印）：

```
randomized check: 60 seeds x 40 edits = 2400 edits; avg reparsed 3.9 lines/edit, avg doc size 19.0 lines
```

另用 400 种子 × 60 次编辑（共 24000 次随机编辑）做了压力核对，
增量树与完整重建全部一致。
