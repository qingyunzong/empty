# accrual-cert

资管按日计提利息：费率为时间的分段多项式（有理数系数），支持历史更正（backdate）
并出具可验证的重算证书（certificate）。Node.js 22，仅标准库，测试用 `node:test`。

## 命令（NDJSON CLI）

`node cli.js`，stdin 每行一个 JSON 命令，stdout 每行一个 JSON 响应：

- `{"cmd":"loadCurve","segments":[{"from":0,"to":2,"coefs":[[1,1],[2,1]]},...]}`
  系数 `coefs[i] = [num, den]` 为 `t^i` 的有理数系数；分段为半开区间 `[from, to)`，重叠报 `E_SEG`。
- `{"cmd":"post","day":0,"amountNum":1,"amountDen":1}` → `{"ok":true,"id":1}`；越界报 `E_DAY`。
- `{"cmd":"backdate","day":0,"newAmount":{"num":2,"den":1}}` 更正该日最近一笔有效过账。
- `{"cmd":"undoPost","id":1}` 撤销过账，提交根哈希随之恢复。
- `{"cmd":"certify","from":0,"to":4}` 出具证书；区间未被曲线完全覆盖时报 `E_PENDING`（绝不返回零）。
- `{"cmd":"verify","cert":{...}}` 校验证书；失败报 `E_CERT`。
- `{"cmd":"root"}` 当前提交根（stateRoot / curveRoot）。

## 核心机制

- **精确有理数**：所有系数、积分、计提额用 BigInt 有理数（`src/rational.js`），全程无浮点误差。
- **Horner 精确求值**：原函数 `P(t)=Σ c_i/(i+1)·t^(i+1)` 用 Horner 在有理数域求值，
  日计提额 = `Σ_postings amount · (P(d+1) − P(d))`（`src/curve.js`）。
- **边界归属统一**：所有分段为 `[from, to)`，积分按整数日界切分，跨段区间在边界处断开求和。
- **增量重算**：日计提结果按日缓存；`backdate`/`undoPost` 仅使 `day` 及之后的缓存失效，
  跨段更正只重算受影响的积分子区间（证书 `stats.daysComputed` 可观察）。
- **证书**（`src/ledger.js` `certify`）：包含逐日精确额、按段子区间的区间和、
  端点残差（`residualFrom=0`、`residualTo=Σ(exact−posted)`）、日条目 Merkle 根、
  曲线承诺根与状态提交根。
- **可验证性**：`verify` 不需要原曲线副本——由证书内日条目重建 Merkle 根、重算区间和与
  残差、检查舍入误差界，最后比对**提交根**（stateRoot/curveRoot）。任何历史更正都会
  改变提交根，使旧证书失效。
- **舍入**：仅在出账时按分舍入（半进位、远离零），每个段子区间舍入一次；
  误差界 `Σ|exact − posted| ≤ 段数 × 半分`，`verify` 强制检查该界。

## 错误码

`E_SEG`（分段重叠/非法）、`E_DAY`（日越界/无此过账）、`E_CERT`（证书校验失败）、
`E_PENDING`（区间未被曲线覆盖，不返回零）。

## 测试（真实结果）

`node --test`，Node v22.22.1，13/13 通过：

```
ok 1 - two-segment polynomial matches hand-computed integrals
ok 2 - backdate invalidates old certificate, new certificate verifies
ok 3 - undoPost restores the committed root hash
ok 4 - N<=7 brute-force daily quadrature matches exact accrual
ok 5 - rounding error bound: sum |exact - posted| <= segments * half cent
ok 6 - E_SEG on overlapping segments
ok 7 - E_DAY on out-of-range post and unknown undo
ok 8 - E_PENDING on uncovered certify range, never a zero
ok 9 - E_CERT on tampered certificate
ok 10 - backdate only recomputes days from the correction onward
ok 11..13 - CLI: full command flow / verify round-trip + E_CERT / malformed input
# pass 13  # fail 0
```

验收对照：

1. 两段多项式 `p=1+2t`（[0,2)）与 `p=t²`（[2,4)）：逐日精确值 `2, 4, 19/3, 37/3`，
   区间和 `6`、`56/3`，与手算积分一致。
2. `backdate` 后 stateRoot 改变，旧证书 `verify` 抛 `E_CERT`，新证书可验。
3. `undoPost` 后 stateRoot 恢复到过账前的值。
4. N=7 暴力逐日求积（20000 步中点法则）与精确有理数结果误差 < 1e-6，
   且总量等于闭式解 `3/2·[t/2+t²/6+t³/21]₀⁷ = 42`。

注：本沙箱环境对子进程 stdio 有限制，CLI 端到端测试通过 `src/cliCore.js`
（与 `cli.js` 完全相同的代码路径）在进程内驱动；真实管道冒烟 `printf ... | node cli.js` 已手工验证。
