# 审计同步库 — 验收结果（真实输出）

运行环境：Node.js v22.22.1，仅标准库 + `node:test`，单机离线。
运行日期：2026-10-02。全部命令在工作区根目录执行。

## 1. 测试套件：`node --test test/*.test.js`

```
ok 1 - test/check.test.js
ok 2 - test/crash.test.js
ok 3 - test/enumerate.test.js
ok 4 - test/scale.test.js
# tests 4
# pass 4
# fail 0
# duration_ms 151841.07905
```

各文件子测试（真实输出）：

```
== scale ==
ok 1 - 20 snapshots x 5000 deltas, corrupted chunk -> restore falls back to nearest trusted point
ok 2 - missing chunk surfaces code=50 in check and restore falls back
ok 3 - seq hole in delta log fails with code=51
ok 4 - same seq different content between snapshot and delta log -> conflict
ok 5 - undo reverses add entries, including across a snapshot boundary
== crash ==
ok 1 - kill before manifest commit -> uncommitted snapshot ignored, previous snapshot used
ok 2 - kill after manifest commit -> snapshot trusted, restore uses it
ok 3 - kill before manifest fsync leaves only tmp file -> treated as uncommitted
== check ==
ok 1 - check emits a coverage proof that an independent command verifies
ok 2 - independent verification rejects a tampered proof and a mutated store
ok 3 - check exits with code 50 on missing chunk and 51 on seq hole
```

枚举测试诊断行（真实输出）：`# combos=8190 snapshots=45057 deltas=45057`
（n=1..12 的全部 2^(n+1)-2 = 8190 种快照/增量组合，逐一 restore 与参考余额模型比对一致。）

## 2. 验收点对照

| 验收 | 结果 |
|---|---|
| 20 快照 × 5000 delta，注入坏块，restore 回退最近可信点 | 通过：snap-000020 块被改后回退 snap-000019，重放至 seq 5000，余额与参考模型一致 |
| kill 在 manifest 提交前 → 用上一快照；提交后 → 新快照可信 | 通过：SIGKILL 三种落点（before-manifest-fsync / before-commit / after-commit）分别验证 |
| n≤12 枚举快照+delta 组合对照余额 | 通过：8190 组合全量比对 |
| check 证明可被独立命令验证 | 通过：`check --proof` 生成证明，`check --verify` 独立重算比对；篡改证明或改动库均被拒绝 |

## 3. CLI 真实输出

### `node cli.js snapshot --store D --state s0.json --chunk-size 64`

```json
{
  "snapshot": {
    "version": 1,
    "snapshotId": "snap-000001",
    "baseSeq": 0,
    "chunkSize": 64,
    "chunkCount": 1,
    "chunks": [
      {
        "file": "chunks/chunk-000000",
        "sha256": "f2882c56eb74c06d3ac9b2be8a6c739bc0aa5c69a2ed4f94be8a7fb61917b804"
      }
    ],
    "stateHash": "f2882c56eb74c06d3ac9b2be8a6c739bc0aa5c69a2ed4f94be8a7fb61917b804",
    "deltaHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  }
}
```

### `node cli.js delta --store D --ops '[{"type":"add","account":"cash","amount":150}]'` 等三笔

依次追加 `seq=1`（add cash +150）、`seq=2`（correct equity → -180）、`seq=3`（undo seq 1）。

### `node cli.js restore --store D`

```json
{
  "trustedPoint": {
    "snapshotId": "snap-000001",
    "baseSeq": 0
  },
  "appliedThrough": 3,
  "finalStateHash": "a5a47d2d86262b5af838de9b93193966a26ae33f7e6167d8137e7afc283708b0",
  "state": {
    "accounts": {
      "cash": 1000,
      "equity": -180
    }
  }
}
```

（undo seq 1 撤销了 +150，correct 生效，结果与语义一致。）

### `node cli.js check --store D --proof proof.json` → 退出码 0，写出覆盖证明

证明包含：每个快照的 committed/status/baseSeq/stateHash/manifestHash、delta 链
`{count, firstSeq, lastSeq, contiguous, deltaHash}`、trustedPoint、恢复终态哈希、proofHash。

### `node cli.js check --store D --verify proof.json`（独立验证，退出码 0）

```json
{
  "verified": true,
  "proofHash": "7bdde5dcd5db76bd850ff5d2d16d558ffbe4184e5a9a01f794ea8d237224d0a5",
  "expectedProofHash": "7bdde5dcd5db76bd850ff5d2d16d558ffbe4184e5a9a01f794ea8d237224d0a5"
}
```

## 4. 错误码真实输出

块缺失（`node cli.js check --store BAD`，退出码 50）：

```
{"error":"chunk missing: snap-000002/chunks/chunk-000000","code":50}
```

seq 空洞（`node cli.js restore --store HOLE`，退出码 51）：

```
{"error":"seq hole: expected 2, found 7","code":51}
```

另：同 seq 不同内容（快照 manifest 的 deltaHash 与 delta.log 前缀不符）→ code 52，见 scale 测试 4。
