# RESULTS

Date: 2026-10-02 · Node v22.22.1 · stdlib only · runner: `node --test`

## `node --test` (real output)

```
ok 1 - test/allocation.test.js
ok 2 - test/budget.test.js
ok 3 - test/cli.test.js
ok 4 - test/refund.test.js
ok 5 - test/revoke.test.js
# tests 5
# suites 0
# pass 5
# fail 0
# duration_ms 13787.608797
```

22/22 individual tests pass across 5 files:

```
test/allocation.test.js
  ok - tie-break: equal amounts split remainder by lineId lexicographic order
  ok - tie-break: single remainder unit goes to lexicographically smallest lineId
  ok - stability: result is identical for every input permutation
  ok - brute-force cross-check on small orders
  ok - zero-amount lines fall back to equal split with lineId tie-break
test/budget.test.js
  ok - B: refund up to exactly the budget limit is accepted
  ok - B: exceeding the limit is rejected with no partial deduction
  ok - B: single refund larger than the whole budget is rejected entirely
  ok - budget aggregates per merchant and period; revoke frees budget
test/cli.test.js
  ok - CLI: happy path applies ops and reports JSONL results on stdout
  ok - CLI: --as-of skips ops dated in the future
  ok - CLI: budget exceeded -> exit!=0 and stderr {code,message}
  ok - CLI: settled revoke with reverse -> exit!=0, stderr carries reversal
  ok - CLI: rollback path error surfaces path on stderr
  ok - CLI: usage error exits non-zero with E_USAGE
test/refund.test.js
  ok - refund recomputes discount allocation, tax and points
  ok - refund exceeding remaining line amount is rejected
  ok - duplicate refId and unknown order/line rejected
test/revoke.test.js
  ok - A: revoking a parent refund cascades and restores original discount/tax/points
  ok - E_ROLLBACK_PATH: settled child blocks revoke, whole subtree unchanged
  ok - D: revoke of settled refund errors; reverse option generates reverse flow
  ok - revoke of unknown or already-revoked refund rejected
```

## Acceptance mapping

- **A 两级撤销恢复原始优惠** — `test/revoke.test.js` “A”: r1、r2 两级退款后 revoke(r1) 级联回滚 r2，`computeOrder` 的每行优惠分摊/税额/积分与原始订单完全一致。
- **B 预算边界** — `test/budget.test.js`: gross 恰好等于 limit(1100)通过；+1 即 `E_BUDGET_EXCEEDED`，且 `used`、订单状态、退款记录零变化（无部分扣减）。
- **C 并列分摊对照暴力枚举** — `test/allocation.test.js`: 1026 个小订单场景，枚举所有“余数接收者子集”，验证规则唯一命中且与 `allocate()` 完全一致；另验证全部输入排列下结果稳定。
- **D 已结算 revoke** — `test/revoke.test.js` “D”: 已结算退款 revoke 抛 `E_ALREADY_SETTLED`；`{reverse:true}` 时生成反向流 `r1:rev`（gross 与 effects 取负），原退款保持 settled。

## CLI smoke (real process)

`node src/cli.js apply ops.jsonl --as-of 2026-10-15`：成功路径 stdout 输出 JSONL 结果、exit 0；已结算 revoke 场景 stderr 输出
`{"code":"E_ALREADY_SETTLED","message":"...","reversal":{...}}`，exit 1。

## Notes

- 金额一律整数最小单位；税率/积分率按 1e6 微精度整数运算，避免浮点误差。
- 优惠/税额/积分是 `(order, refunded)` 的纯函数，撤销即恢复状态，天然保证“子项失败整棵子树不变”。
- 沙箱禁止 node 派生子进程，CLI 测试通过进程内 `run(argv, io)` 驱动（同一代码路径），真实进程行为另以上述 smoke 验证。
