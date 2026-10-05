# dom-query

无浏览器依赖的 DOM 树查询库。TypeScript 编写，仅使用 Node.js 内置模块
（`node:test` / `node:assert`），无任何 npm 运行时依赖。

## 功能

- **选择器**：标签、`*`、`.class`、`[attr]`、`[attr=value]`（可带引号）、
  `:nth-child(an+b)`（支持 `odd`/`even`/`2n+1`/`-n+3` 等）
- **组合器**：子代 `>`、后代（空白）
- **选择器列表**：逗号分隔，结果**去重**且按**文档树序**返回
- **增量索引**：`DomIndex` 挂在根元素上，通过树事件（插入/删除/属性类名变更）
  增量维护 tag/class/attr 倒排索引
- **无旧父关系**：索引只缓存元素自身特征，父子关系永远实时读树；
  移动子树时先触发 `removed`（脱离前冒泡到旧根）再触发 `inserted`，
  索引成员关系随子树整体更新，不会残留旧的父/祖先关系

## 结构

- `src/tree.ts` — 树模型 `El`：`insertAt`/`appendChild`/`removeChild`/`remove`
  （对已挂载节点再插入即移动）、`setAttr`/`addClass` 等，事件沿父链冒泡
- `src/selector.ts` — 选择器解析器与 `an+b` 求值
- `src/query.ts` — `scanQuery`（全扫描参考实现）、`DomIndex`、`indexedQuery`
  （索引取候选 + 实时树验证 + 树序去重）
- `test/` — 解析器、固定树查询对照、增量索引（含移动/删除/模糊测试）

## 对照验证

`indexedQuery` 的结果与 `scanQuery`（全树扫描参考模型）逐项对比：

- 固定树上 26 组选择器（含列表去重与树序）逐一断言
- 5 个随机种子 × 400 步随机操作（插入/移动/删除/属性类名变更），
  每步对 17 个选择器断言两种实现结果完全一致，并校验索引大小与树大小同步

## 运行

```sh
npm test    # tsc 编译到 dist/ 后运行 node --test
npm run build
```

要求：Node.js（开发环境为 v22.22.1）与 TypeScript 编译器（开发环境为 tsc 7.0.2）。
注意：本环境的 Node 构建未启用 TypeScript 类型剥离，因此测试先编译再运行。

## 实际测试结果（2026-10-05，Node v22.22.1 + tsc 7.0.2）

`npm test` 输出摘要：

```
ok 1 - dist/test/incremental.test.js
ok 2 - dist/test/query.test.js
ok 3 - dist/test/selector.test.js
# tests 3
# pass 3
# fail 0
```

逐文件直接运行的子测试统计（本环境 `node --test` 按文件粒度汇总）：

| 文件 | 通过/总数 | 内容 |
| --- | --- | --- |
| `test/selector.test.ts` | 8/8 | 解析器：复合选择器、属性、组合器、列表、nth-child 变体、非法输入 |
| `test/query.test.ts` | 2/2 | 固定树上 26 组选择器的期望值断言 + 索引/全扫描一致性 |
| `test/incremental.test.ts` | 5/5 | 移动不留旧父关系、删除后 nth-child 重排、子树移动后插入、属性类名变更重索引、5 种子×400 步随机操作模糊对照 |

合计 15/15 通过。
