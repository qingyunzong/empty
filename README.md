# audit-sampler

分层配额抽样库与 CLI：面向结算流水审计，**无偏、可复现、可验证**，支持撤销/更正后的**增量重抽**与旧证书失效证明。Node.js 22，仅标准库，单机离线。

## 核心机制

- **分层配额**：`quotas` 按 stratum 指定样本量；配额必须是非负整数且不超过总体，否则报 `QUOTA`。配额为 0 合法（该层不抽样）。`quotaUse` 报告每层 `quota / used / population`。
- **确定性随机**：每项排名为 `SHA256(seed | stratum | itemKey)`，取排名最小的 `quota` 项。等价于均匀随机置换 ⇒ 每个大小为 `quota` 的子集等概率（无偏）；同 seed 同版本必得同样本（可复现）；任何人可用 seed 重算（可验证）。
- **并发历史**：流水条目以 `(source, seq)` 标识，`version` 高者胜（更正覆盖旧值）；同 `(version, source, seq)` 但内容不同 ⇒ `VERSION_CONFLICT`；`revoked: true` 的高版本条目将该项移出总体。
- **增量重抽**：证书承诺 `(stratum, quota, population, populationHash, sample)`（刻意不含版本号——populationHash 才是强绑定）。传入上一次输出作为 `prev` 时，只有 populationHash 或配额变化的 strata 被重抽；未受影响 strata 的证书原样保留。被替换的旧证书标记 `SUPERSEDED` 进入 `invalidated`，附 `supersededCertificateHash`、`previousMerkleRoot` 与 `invalidationProof`（旧证书在旧 merkle 树中的存在性证明）。旧证书从不删除。
- **缺失 strata 不是空总体**：`quotas` 引用了没有流水数据的 stratum ⇒ `STRATA_MISSING`，`details.missing` 列出全部缺口。

## 输出

```json
{
  "ok": true,
  "seed": "...",
  "version": 7,
  "samples": { "retail": ["core#3", "core#9"] },
  "certificates": [ { "stratum": "...", "sample": ["..."], "certificateHash": "...", "merkleProof": [] } ],
  "merkleRoot": "…",
  "invalidated": [ { "stratum": "...", "status": "SUPERSEDED", "reason": "POPULATION_CHANGED", "invalidationProof": [] } ],
  "quotaUse": { "retail": { "quota": 2, "used": 2, "population": 10 } }
}
```

## 错误码

`SEED_REQUIRED`（缺 seed）、`QUOTA`（配额非法或超过总体）、`VERSION_CONFLICT`（同版本同键不同内容）、`STRATA_MISSING`（配额引用了缺失 strata）、`INPUT_INVALID`（JSON 无法读取/解析）。

## CLI

```sh
node bin/audit-sample.js input.json     # 或 cat input.json | node bin/audit-sample.js
```

stdout 始终输出 JSON；成功退出码 0，失败退出码 2。增量重抽把上一次输出作为 `prev` 字段传入；`{"verify": true, "result": …}` 进入验证模式，重算并比对 merkleRoot、samples 与证书证明。

## 库

```js
const { plan, verify } = require('./src/sampler');
const first = plan({ seed, version, strata, quotas });
const second = plan({ seed, version: version + 1, strata: newStrata, quotas, prev: first });
const report = verify({ strata: newStrata, quotas }, second); // { ok, checks }
```

## 测试

```sh
node --test
```

覆盖：配额边界（0 / 等于总体 / 超过总体 / 非整数）、确定性与不同 seed、并发版本判定与 `VERSION_CONFLICT`、撤销后仅重抽受影响 strata 且旧证书 `SUPERSEDED` 并可验证失效证明、`n<=12` 全量对照独立分层枚举、600 个固定 seed 的无偏性频率检验、CLI 各错误码退出码 2。
