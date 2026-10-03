# RESULTS

环境：Node.js v22.22.1（仅标准库 + node:test），单机离线，空仓库起步。
记录时间：2026-10-03T08:16Z（UTC）。

## 全量测试（真实运行输出）

命令：`node --test`

```
ok 1 - test/enumeration.test.js
ok 2 - test/recon.test.js
# tests 2
# pass 2
# fail 0
# duration_ms 8693.752815
```

逐条子测试（`node test/recon.test.js` / `node test/enumeration.test.js`）：

```
ok 1 - A: identical balanced books -> balanced, verifiable accept certificate
ok 2 - A: reordering allowed while per-account causality is preserved
ok 3 - A: reordering that breaks per-account causality is rejected
ok 4 - B: one-sided extra entries -> removeExtra
ok 5 - C: relation-id mismatch -> relink
ok 6 - tied minimal scripts are all returned (addMissing vs removeExtra)
ok 7 - E: beyond K -> SEARCH_BOUND, certificate carries proven lower bound
ok 8 - E: the same books pass with a larger bound (min cost = 6)
ok 9 - DUP_ID: duplicate event id in one book
ok 10 - CURRENCY_MIX: a relation group mixing currencies
ok 11 - SIZE_LIMIT: more than 200 events per book
ok 12 - CERT_INVALID: tampered certificates are rejected
ok 13 - scripts cap: truncation is signalled, never silent
ok 1 - D: product automaton == equivalence criterion == brute-force reference
ok 2 - D: sampled end-to-end diffBooks repair scripts are valid and minimal
```

合计 15/15 通过，0 失败。

## 验收项对照

- **A 完全平衡**：相同账本与保持账户因果序的重排均判 `balanced: true`，
  accept 证书可 `verifyCertificate` 重放；破坏账户因果序的重排判拒绝
  （`reason: "account-order"`）。
- **B 单边多账**：右账多一条未配对事件 → 唯一最优脚本
  `[{op:"removeExtra", book:"right", id:"e9"}]`（代价 1）。
- **C 关联号错配**：左账 e2 关联号 `rX`、右账为 `r1` → 唯一最优脚本
  `[{op:"relink", book:"left", id:"e2", rel:"r1"}]`（代价 1）。
- **D 枚举对照**：8 事件池（2 账户、2 币种、4 个平衡关联号组）的全部
  2^8=256 个子集（含反序副本共 512 个账本），规范序子集两两全组合
  （256×256=65536 对）+ 每个子集与自身反序（256 对）= 65792 对，
  显式乘积自动机 BFS、等价判据、独立暴力参考实现三者结果完全一致；
  另对 16 个平衡子集两两（256 对）+ 抽样约 262 对端到端跑 `diffBooks`，
  返回的每个脚本都实际 apply 验证可修复且代价最小。
- **E 超界**：右账多 6 条未配对事件（最小代价 6），`--k 5` →
  `error.code = "SEARCH_BOUND"`，证书 `type: "search-bound"`，
  `provenLowerBound: 6`（已证下界），且内嵌 reject 证书可验证；
  `--k 6` 时同一对账本给出代价 6 的脚本（6×removeExtra）。
- **规模限制**：每本账 >200 事件抛 `SIZE_LIMIT`。

## CLI 冒烟（真实运行）

- `node cli.js diff examples/a-left.jsonl examples/a-right.jsonl --k 5`
  → `balanced: true`，退出码 0。
- `node cli.js diff examples/a-left.jsonl examples/b-right.jsonl --k 5`
  → 代价 1 脚本 `removeExtra right e9`，退出码 1。
- `node cli.js diff examples/c-left.jsonl examples/c-right.jsonl --k 5`
  → 代价 1 脚本 `relink left e2 -> r1`。
- `node cli.js diff examples/a-left.jsonl examples/e-right.jsonl --k 5`
  → `SEARCH_BOUND`，`provenLowerBound: 6`。
- `node cli.js verify ... /tmp/cert-b-only.json` → `{"valid":true}`，退出码 0；
  篡改证书后 → `CERT_INVALID`，退出码 3。
