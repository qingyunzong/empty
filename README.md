# version-dag

多父提交版本图库（TypeScript + Node.js 内置库，零运行时依赖）：

- **多父提交 DAG**：`VersionGraph.addCommit(id, parents)` 追加提交，边方向为 子 -> 父。
- **全部最近共同祖先（merge bases）**：`lowestCommonAncestors(graph, queries)`
  返回共同祖先中"无更近共同后代"者——即不存在另一共同祖先是它的真后代。
  支持任意多个查询基点。判定利用性质：若共同祖先 c 的某真后代仍是共同祖先，
  则 c 朝该后代的第一条边所指的直接子节点也是共同祖先，故只需检查直接子节点。
- **增量插入拒环**：`addParents(child, parents)` 为已有提交追加父边；
  若新边会成环（child 已是该父提交的祖先，含自环）则整体拒绝并抛 `CycleError`，
  操作原子，图保持原状。
- **祖先关系证书**：`issueAncestorCertificate` 输出 ancestor -> descendant 的
  有向路径证书，`verifyAncestorCertificate` 逐边核对即可，无需全图遍历；
  `issueMergeBaseCertificate` 为每个基点给出到每个查询点的路径集合。
- **模型核对**：`src/model.ts` 提供独立的暴力全可达集合参考实现，
  测试在随机小 DAG 上逐点比对库结果与模型结果。

## 运行

需要 Node.js（>= 18）与可用的 `tsc`（TypeScript 编译器，本仓库用 7.0.2 验证）。

```sh
npm test   # = tsc -p tsconfig.json && node --test "dist/test/*.test.js"
```

## 结构

- `src/graph.ts` — 版本图、增量插入、环检测、祖先/后代遍历
- `src/lca.ts` — 共同祖先交集与全部最近共同祖先
- `src/certificate.ts` — 祖先证书与合并基点证书的签发/验证
- `src/model.ts` — 暴力全可达集合参考模型
- `test/` — 单元测试 + 随机小 DAG 模型核对（种子可复现）

## 实际测试结果

环境：Node.js v22.22.1，tsc 7.0.2，npm 9.2.0。

```
$ npm test
# Subtest: dist/test/certificate.test.js
ok 1 - dist/test/certificate.test.js      # 4 个用例
# Subtest: dist/test/graph.test.js
ok 2 - dist/test/graph.test.js            # 7 个用例
# Subtest: dist/test/lca.test.js
ok 3 - dist/test/lca.test.js              # 6 个用例
# Subtest: dist/test/model.test.js
ok 4 - dist/test/model.test.js            # 2 个用例
# tests 4
# pass 4
# fail 0
```

合计 19 个用例全部通过。其中模型核对覆盖：300 个随机种子
（每个种子 1–14 节点、至多 3 父、随机增量补边）× 每组 8 轮、
每轮 2–4 个查询基点，共 2400 组查询逐一与全可达集合模型比对，
并同步验证每个基点的祖先证书；另有 100 个种子的随机增量插入
拒环/接收性质测试。
