# dom-query-index

DOM 风格选择器查询库：纯树模型（无浏览器对象），支持子代 / 后代 / 类 / 属性 / `:nth-child` 选择器，
选择器列表结果去重并按树序返回。增量索引随树修改（插入、移动、删除）同步更新，不留旧父关系；
正确性由全扫描参考模型对照验证。

## 结构

- `src/tree.ts` — 树模型：`createElement` / `appendChild` / `insertBefore` / `removeChild` / `walk`（移动即重新挂载，防环）。
- `src/selector.ts` — 选择器解析：`div.x[a="1"]:nth-child(2n+1)`、组合器 `>` 与空格、逗号列表（属性值内逗号不分割）。
- `src/query.ts` — 全扫描参考引擎：按文档序遍历，天然去重且树序。
- `src/index.ts` — 增量索引（`all` / `parent` / `children` / `byTag` / `byClass` / `byAttr`）与 `Document` 包装；索引查询走候选集 + 索引导航，结果去重后按索引 DFS 序排序。
- `src/validate.ts` — `validateIndex`：校验索引与活树完全一致（含无残留分离节点）。
- `tests/` — `node:test` 单元测试与差分模糊测试。

## 索引一致性约定

- 移动节点：只重挂被移动根的父链，旧父的 `children` 立即移除该节点。
- 删除子树：子树所有节点从 `all` / `parent` / `children` / 三个查找表全部擦除，无旧父关系残留。
- 重新挂载已删除子树：按活树链接整体重建索引项。

## 运行

```sh
npm test   # tsc 编译到 dist/ 后用 node --test 运行（仅 Node.js 内置模块，无第三方依赖）
```

环境：Node.js v22.22.1，tsc 7.0.2（本机 Node 未编译类型擦除支持，故先编译再运行）。

## 测试结果（实际运行记录）

`npm test` 输出（2026-10-07 运行）：

```
ok 1 - dist/tests/fuzz.test.js
ok 2 - dist/tests/index.test.js
ok 3 - dist/tests/query.test.js
ok 4 - dist/tests/selector.test.js
# tests 4
# pass 4
# fail 0
```

共 20 个子测试全部通过：

- `selector.test.js`（6）：`an+b` 解析与匹配、复合选择器、组合器与列表、属性值内逗号、非法输入报错。
- `query.test.js`（6）：标签 / 类 / 属性、子代与后代组合器、`nth-child`（odd/even/2n+1/-n+2/n+4/复合）、列表去重且按树序、根节点不匹配 `nth-child`。
- `index.test.js`（6）：移动后无旧父关系、删除子树索引项清零、重挂恢复查询、`insertBefore` 顺序同步、索引查询对照全扫描、`validateIndex` 能检出人为注入的旧父关系。
- `fuzz.test.js`（2）：固定种子下 600 步随机插入 / 移动 / 删除，每步 `validateIndex`，每 5 步用 6 个随机选择器做索引查询 vs 全扫描差分对照（>500 组断言全等）；另验证模糊测试本身确定性。
