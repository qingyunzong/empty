# version-dag

多父提交版本图库（TypeScript + Node.js 内置库，零运行时依赖）：

- **多父提交**：`CommitDag.addCommit(id, parents)` 支持 0 个（根）、1 个、多个（合并）父提交。
- **增量插入拒绝环**：插入前做可达性检查——若 `id` 已是某个新父提交的祖先（或自环），
  抛出 `CycleError`；重复 id、悬空父提交、重复父提交抛出 `DagError`。
- **所有最近共同祖先（NCA）**：`lowestCommonAncestors(bases)` 返回共同祖先中
  "无更近共同后代者"——即不存在另一个共同祖先是它的真后代。支持任意多个基点，
  结果可以是多个互不可比的祖先（如 `NCA(J, K) = [B, C]`）。
- **祖先关系证书**：`ancestorCertificate` 输出一条从后代沿父边到祖先的见证路径；
  `lcaCertificate` 输出 LCA 集合及每个基点到每个 LCA 的见证路径；
  `verifyAncestorCertificate` / `verifyLcaCertificate` 独立校验（后者重算 LCA 集合比对）。
- **全可达集合模型核对**：`src/model.ts` 用朴素不动点迭代计算每个提交的完整可达
  （祖先）集合作为规格，测试中对小 DAG 的全部有序对（11²）和全部三元组（11³）
  共 1452 组基点逐一与主实现交叉核对。

## 结构

- `src/dag.ts` — `CommitDag`：插入、拒环、祖先集、NCA、证书签发与校验
- `src/model.ts` — 暴力全可达集合模型（规格/交叉核对用）
- `src/demo.ts` — 演示：建图、NCA 查询、证书输出、拒环演示
- `test/dag.test.ts` — `node:test` 测试
- `types/node.d.ts` — Node 内置模块的最小离线类型声明（环境无 `@types/node`）

## 命令

```sh
npm test    # tsc 编译到 dist/ 后用 node --test 运行测试
npm run demo
```

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 退出码 0。`node dist/test/dag.test.js` 完整输出：

```
# Subtest: insertion: rejects duplicates, dangling parents, repeated parents, empty id
ok 1 - insertion: rejects duplicates, dangling parents, repeated parents, empty id
# Subtest: insertion: rejects cycles (self-loop and reachability check)
ok 2 - insertion: rejects cycles (self-loop and reachability check)
# Subtest: nearest common ancestors: hand-computed expectations
ok 3 - nearest common ancestors: hand-computed expectations
# Subtest: model cross-check: NCA matches full-reachability model for all pairs and triples
ok 4 - model cross-check: NCA matches full-reachability model for all pairs and triples
# Subtest: model cross-check: ancestor relation matches for all ordered pairs
ok 5 - model cross-check: ancestor relation matches for all ordered pairs
# Subtest: model cross-check: reachability sets match dag.ancestors()
ok 6 - model cross-check: reachability sets match dag.ancestors()
# Subtest: ancestor certificates: issued and verified for every true relation
ok 7 - ancestor certificates: issued and verified for every true relation
# Subtest: ancestor certificates: tampered certificates are rejected
ok 8 - ancestor certificates: tampered certificates are rejected
# Subtest: LCA certificates: verified, and tampering is detected
ok 9 - LCA certificates: verified, and tampering is detected
# Subtest: certificate output sample (recorded in test log)
ok 10 - certificate output sample (recorded in test log)
# ancestor certificate: {"kind":"ancestor","ancestor":"A","descendant":"I","path":["I","G","E","B","A"]}
# lca certificate: {"kind":"lca","bases":["J","K"],"lcas":["C","B"],"paths":{"C":{"J":["J","C"],"K":["K","C"]},"B":{"J":["J","B"],"K":["K","B"]}}}
1..10
# tests 10
# pass 10
# fail 0
```

`npm run demo` 关键输出：

```
NCA(D, F) = [A]
NCA(E, F) = [C]
NCA(H, G) = [E]
NCA(J, K) = [C, B]
NCA(H, G, K) = [C, B]
Cycle rejection demo: CycleError: adding Z with parents [Z] would create a cycle
```
