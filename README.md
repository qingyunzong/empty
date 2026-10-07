# interest-cert

资管系统按日计提利息：费率是时间的分段多项式（有理数系数），历史更正后
可出具可验证的重算证书。Node.js 22，仅标准库，测试用 `node:test`，单机离线。

## 模型

- 曲线：`{segments:[{from,to,coefs:[[num,den]...]}]}`，`coefs[i]` 是 `t^i` 的
  有理数系数（BigInt 分数，自动约分）。
- 边界归属统一为 `[from, to)`：日 `t` 属于满足 `from <= t < to` 的段；
  积分在段边界切分，不重复计数。
- 计提：`post` 的金额自 `max(postDay, from)` 起息到 `to`，按
  `金额 × ∫rate(t)dt` 精确计算。积分对原函数系数做 Horner 精确求值
  （`Q[k]=c[k-1]/k`），全程有理数，无浮点误差。
- 舍入仅发生在出账：每个（过账 × 段）积分子区间独立四舍五入到分
  （half away from zero）。误差界 `Σ|精确-入账| ≤ 段数 × 半分`，
  证书内携带 `errorBound` 并在 certify/verify 时校验。

## 证书与验证

- Merkle 根只提交曲线段与存活过账（`post:id:day:amount:v版本`），
  不含证书与缓存，因此出具证书不会移动根。
- 证书包含：区间和（每子区间 exact/booked/residual 及总计）、
  端点残差（首/末子区间残差）、Merkle 根、误差界。
- `verify` 不依赖原曲线副本：用当前状态重算根并与证书提交根比对，
  不一致即 `E_CERT`（证书失效）；再重算总账比对并校验误差界。
- 增量重算：积分结果按 `(曲线哈希, 过账id, 版本, 段, 区间)` 缓存，
  `backdate` 只递增被更正过账的版本号，因此只重算受影响的积分子区间
  （证书 `stats.recomputed/reused` 可观察）。

## 错误码

- `E_SEG`：段重叠或段边界非法。
- `E_DAY`：过账/更正日越界（不在曲线覆盖内）、引用不存在的过账。
- `E_CERT`：证书未知、根不匹配（已失效）、重算分歧或残差超界。
- 未覆盖区间：`certify` 返回 `E_PENDING`（附 `uncovered` 区间列表），绝不返回零。

## CLI

```sh
node cli.js loadCurve '{"segments":[{"from":0,"to":2,"coefs":[[1,1]]},{"from":2,"to":5,"coefs":[[0,1],[1,2]]}]}'
node cli.js post '{"day":0,"amountNum":1000,"amountDen":1}'
node cli.js backdate '{"day":0,"newAmount":[2000,1]}'
node cli.js undoPost '{"id":1}'
node cli.js certify '{"from":0,"to":5}'
node cli.js verify '{"certId":"cert-1"}'
node cli.js root
```

状态存于 `interest-state.json`（可用环境变量 `INTEREST_STATE` 覆盖）。
成功输出 JSON、退出码 0；业务错误输出 `{"error":...}`、退出码 1。

## 测试（真实结果）

`node --test`，2026-10-08 于 Node v22.22.1 实跑：**8/8 通过，0 失败**。

```
ok 1 - 1. two-segment polynomial matches hand-computed integral
ok 2 - 1b. rounding happens only at booking, residual within half a cent per segment
ok 3 - 2. backdate invalidates old certificate, new certificate verifies
ok 4 - 2b. backdate recomputes only the affected integral sub-intervals
ok 5 - 3. undoPost restores the previous Merkle root
ok 6 - 4. brute-force daily summation matches certificate for N <= 7 days
ok 7 - error codes: E_SEG, E_DAY, E_PENDING, E_CERT
ok 8 - CLI end-to-end: loadCurve/post/certify/verify, backdate invalidates
```

验收对照：

1. 两段曲线 `r=1`（[0,2)）与 `r=t/2`（[2,5)），金额 1000：手算积分
   `2 + (25-4)/4 = 29/4`，利息 `7250`，与证书 `exactTotal` 一致。
2. `backdate` 后旧证书 `verify` 抛 `E_CERT`（根不匹配），新证书可验。
3. `post` 后 `undoPost`，Merkle 根恢复为原值（CLI 实测根
   `29b2ecc4…` 一致）。
4. 三段曲线、三笔过账，N=1..7 逐日暴力积分求和与证书 `exactTotal`
   逐一相等，且残差均在 `段数×半分` 界内。

## 结构

- `src/rational.js` — BigInt 有理数与出账舍入。
- `src/curve.js` — 分段校验（E_SEG）、Horner 精确积分、覆盖查询。
- `src/merkle.js` — sha256 Merkle 树。
- `src/ledger.js` — 过账/更正/撤销/出具/验证、增量缓存、错误码。
- `cli.js` — 命令分发与状态持久化（`runCommand` 可进程内复用）。
