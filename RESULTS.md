# RESULTS

- 环境：Node.js v22.22.1，仅标准库，离线单机
- 日期：2026-10-04 19:53:45 CST
- 规模约束：n<=500、m<=5000（规模测试实测 n=500、m=5000）

## 设计要点

- 图版本：`version = sha256(canonical(nodes, edges))`，所有证书字段均绑定该版本；图重建后旧证书输出 `VERSION_MISMATCH`。
- reach 证书：BFS 路径 + 逐边哈希 `edge_hash = sha256(edge|version|from|to)` 与链式 `chain_root`；改任一边、缺层（少一个 edge_hash）、假路径均为 `CERT_INVALID`。
- nonreach 证书：s 的可达集 R（排序）+ 边界边列表（R 中节点的全部出边，验证闭包用）+ `set_hash`/`boundary_hash`；验证方重算 BFS 闭合并逐条比对，删任一边界边即 `CERT_INVALID`。
- 完整性：`cert_hash = sha256(canonical(cert 除 cert_hash 外全部字段))`，覆盖 expires_at，篡改有效期即失效；过期证书 `CERT_INVALID`。
- 证明 id：`proof_id = sha256(version|kind|s|t|payload)`（确定性），签发注册表拒绝重复 id（`DUPLICATE_PROOF_ID`），verify 要求 id 已注册。
- 输出仅为 `VALID` / `CERT_INVALID` / `NO_SUCH_NODE` / `VERSION_MISMATCH`；系统无 `NO_PATH` 输出——BFS 为 O(n+m)，不存在证明超时路径，不可达时 prove_reach 返回 `UNREACHABLE` 并拒绝发证。

## `node --test`（真实输出）

```
TAP version 13
# Subtest: test/acceptance.test.js
ok 1 - test/acceptance.test.js
  ---
  duration_ms: 3973.717879
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
# duration_ms 4199.589397
```

## `node test/acceptance.test.js`（逐条验收）

```
TAP version 13
# Subtest: 1. reach certificate verifies; tampering any edge fails
ok 1 - 1. reach certificate verifies; tampering any edge fails
  ---
  duration_ms: 4591.706992
  type: 'test'
  ...
# Subtest: 2. nonreach certificate verifies; deleting a boundary edge fails
ok 2 - 2. nonreach certificate verifies; deleting a boundary edge fails
  ---
  duration_ms: 135.375287
  type: 'test'
  ...
# Subtest: 3. multi-source contamination locates first contaminating edge
ok 3 - 3. multi-source contamination locates first contaminating edge
  ---
  duration_ms: 16.62797
  type: 'test'
  ...
# Subtest: 4. n<=9 random graphs cross-checked against BFS enumeration
ok 4 - 4. n<=9 random graphs cross-checked against BFS enumeration
  ---
  duration_ms: 2856.195882
  type: 'test'
  ...
# Subtest: 5. edge cases: empty graph, self-loop, duplicate proof id
ok 5 - 5. edge cases: empty graph, self-loop, duplicate proof id
  ---
  duration_ms: 127.64387
  type: 'test'
  ...
# Subtest: expiry, version binding and missing nodes on verify
ok 6 - expiry, version binding and missing nodes on verify
  ---
  duration_ms: 23.511881
  type: 'test'
  ...
# Subtest: verify reports NO_SUCH_NODE for endpoints absent from graph
ok 7 - verify reports NO_SUCH_NODE for endpoints absent from graph
  ---
  duration_ms: 56.844642
  type: 'test'
  ...
# Subtest: scale: n=500, m=5000 prove and verify complete quickly
ok 8 - scale: n=500, m=5000 prove and verify complete quickly
  ---
  duration_ms: 417.008133
  type: 'test'
  ...
1..8
# tests 8
# suites 0
# pass 8
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 8624.128362
```

## CLI 实测（图：M1,M2→MIX1→MIX2→P，Q→M2）

```
$ node cli.js build --graph graph.json --store store.json
449f828c474c33cbaf847ed252232bb126a5e347a2b5bca7ac0fea90c7233645

$ node cli.js prove_reach --store store.json --s M1 --t P --out reach.json
f5c220b443e8889e236b157b450450ed09584636d47decaa34a2cee30f7ad59f

$ node cli.js verify --store store.json --proof reach.json
VALID

# tamper one path edge (MIX2->P becomes MIX2->M1):
$ node cli.js verify --store store.json --proof bad.json
CERT_INVALID

$ node cli.js prove_nonreach --store store.json --s P --t M1 --out nr.json
08612c5efeb5aa4a89560f3360490e8d96d81911bdccbe80690ff1c0c109423e
$ node cli.js verify --store store.json --proof nr.json
VALID

# duplicate issuance of the same proof:
$ node cli.js prove_reach --store store.json --s M1 --t P
DUPLICATE_PROOF_ID

# unknown node:
$ node cli.js prove_reach --store store.json --s M1 --t GHOST
NO_SUCH_NODE

# old cert against rebuilt graph (version binding):
$ node cli.js verify --store store2.json --proof reach.json
VERSION_MISMATCH

# multi-source contamination locate:
$ node cli.js locate --store store.json --sources M1,M2 --t P
{"ok":true,"source":"M1","path":["M1","MIX1","MIX2","P"],"first_edge":{"from":"M1","to":"MIX1"}}
```

## 验收标准对照

1. 路径证书通过且改任一边失败 → 测试 1：VALID；逐边改 hash、改路径节点、缺层、假路径全部 CERT_INVALID。
2. 无路径证书通过且删边界边后失败 → 测试 2：VALID；逐条删除 boundary 边全部 CERT_INVALID。
3. 多源物料混入定位首条污染边 → 测试 3 + CLI locate：反向 BFS 定位最近污染源，返回首条污染边 M1→MIX1。
4. n<=9 与 BFS 枚举对照 → 测试 4：60 个随机图 × 全部 (s,t) 对，简单路径枚举与 BFS 一致，证书均 VALID。
5. 空图、自环、重复证明 id → 测试 5：空图 NO_SUCH_NODE；自环下 A→A 零长路径 VALID；重复签发 DUPLICATE_PROOF_ID。
