# omics-evidence-chain

临床组学核心设施样本链式证据审计：从采集到上机，确认每个样本结论都有
完整、未过期且未被撤销的证据链；断链时给出可复核的最小断链核心。

仅依赖 Node.js 22 标准库；测试使用 `node:test`。

## 模型

- 有限域：实体 `sample | aliquot | assay | batch`；状态 `ACTIVE | QC_FAILED | REVOKED`；
  判定 `VALID | BROKEN | STALE | PENDING`。
- 事件：`register, batch, aliquot, assay, qc_fail, revoke, attest, compact(快照), verify`。
- 约束：亲子体积守恒（分装累计 ≤ 母本剩余）、冷链时限（采集→上机 ≤ 72h）、
  批次试剂兼容（批次须覆盖 assay 类型且未过期）、QC 门控（QC 失败污染下游）、
  撤销传染（revoke 沿派生边传播；已 attest 且不依赖被撤节点的结论保留）。
- `verify` 判定：
  - `VALID`：链完整、未过期、未被撤销，输出含 chainHash 与签名的证书；
  - `BROKEN`：输出最小断链核心（离结论最近的污染源/约束违反前沿）；
  - `STALE`：冷链超时、试剂过期或结论超 TTL；
  - `PENDING`：审计预算（`--budget`）耗尽，非 BROKEN。
- `compact`：将日志压缩为单个 snapshot 事件，verify 结果不变。
  故障点依次为：写 `.tmp` → `fsync` → `rename`（原子）。任一中断后
  `recover` 只能得到旧完整日志或新完整日志。

## 用法

```sh
node src/cli.js <dir> register S1 100 0
node src/cli.js <dir> batch B1 1000 rna-seq,wgs
node src/cli.js <dir> aliquot A1 S1 40 10
node src/cli.js <dir> assay M1 A1 B1 rna-seq 20
node src/cli.js <dir> attest M1 pathologist-1 30
node src/cli.js <dir> revoke S1 consent-withdrawn 40
node src/cli.js <dir> verify M1 --now 50 [--budget N] [--record]
node src/cli.js <dir> compact [--crash-at before-tmp-write|after-tmp-write|after-fsync|after-rename]
node src/cli.js <dir> recover
```

## 测试

```sh
node --test
```
