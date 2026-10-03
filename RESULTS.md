# RESULTS — 真实运行记录

环境：Node.js v22.22.1，仅标准库，单机离线。运行日期：2026-10-03。

## 全量测试：`node --test`

```
# tests 5        # 5 个测试文件（共 40 个断言用例）
# pass 5
# fail 0
# duration_ms 6110.470455
退出码 0
```

分文件用例数（`node <file>` 直接统计 TAP ok 行）：

| 文件 | 用例数 | 结果 |
|---|---|---|
| test/lexer.test.js | 5 | 全部通过 |
| test/rounding.test.js | 8 | 全部通过 |
| test/parser.test.js | 9 | 全部通过 |
| test/vm.test.js | 14 | 全部通过 |
| test/e2e.test.js | 4 | 全部通过 |
| 合计 | 40 | 全部通过 |

## 验收项对照

1. **HALF_EVEN 边界 0.005/0.015**：`test/rounding.test.js` 实测 0.005→0.00（0 为偶）、0.015→0.02、0.025→0.02、0.035→0.04；HALF_UP 0.005→0.01；DOWN 向零截断。每个舍入步断言 `rounded + remainder == input`。
2. **三档并列最低全部输出**：`test/vm.test.js`「three parallel tiers hit」——三档区间 `[0,100)`、`[50,200)`、`[0,∞)` 同时命中金额 75.00，`matchedTiers=[0,1,2]`、`ties=[0,1,2]` 全部列入证书，费用取最低 1.00。
3. **总费用≠分项和 → E_CONSERVE**：`test/vm.test.js` 中订单携带 `expectedTotal=24.99`（实际 25.00）触发 `E_CONSERVE`；`test/e2e.test.js` 中篡改证书 `totalFee` 后重放触发 `E_CONSERVE`。
4. **随机 500 单对照 + 证书重放**：`test/e2e.test.js` 用确定性 PRNG（mulberry32, seed=20261003）生成 500 单（含 6 个档位边界值与 30% 随机 rate override），与测试内独立的 BigInt 参考实现（不引用 src，1e-8 精度整数 + 半偶舍入）逐单比对整数分，全部一致；每单生成证书并 `verifyCertificate` 重放通过，且每单证书含 ROUND 余数记录与守恒恒等式。

## CLI 实测输出

```
$ node bin/fee.js calc examples/sample.fee examples/orders.json --cert
A001: fee=1.00 CNY residual=0 -> TAIL_ACCOUNT tiers=[0]
A002: fee=3000.00 CNY residual=0 -> TAIL_ACCOUNT tiers=[1]
A003: fee=24.69 CNY residual=0.0013578 -> TAIL_ACCOUNT tiers=[0]
certificates written to examples/orders.cert.json

$ node bin/fee.js verify examples/sample.fee examples/orders.cert.json
A001: OK (replayed 4 steps, total=1.00, residual=0 -> TAIL_ACCOUNT)
A002: OK (replayed 4 steps, total=3000.00, residual=0 -> TAIL_ACCOUNT)
A003: OK (replayed 4 steps, total=24.69, residual=0.0013578 -> TAIL_ACCOUNT)
verified 3 certificate(s)
```

## 错误码实测

- `E_LEX`：字面量 `1.12345 CNY`（超 4 位精度）、`1.2.3`、`.5`、`12a`、`$` 均触发；CLI 退出码 1。
- `E_TIER`：金额 50.00 无命中档；赎回单 `-100.00`；`shares: "0"`。
- `E_TYPE`：`25bps + 1.00 CNY`；override `rate: "1.00 CNY"`（期望 bps）；override 未知参数。
- `E_ROUND`：未知舍入模式 `CEILING`。
- `E_CONSERVE`：`expectedTotal` 与计算分项和不等；证书篡改后重放。
