# settle — 有理数结算库（仅 Go 标准库）

## 计算流程（顺序明确且固定）

1. 每行：`数量 × 单价` = 行原始金额（精确有理数，分子/分母可输出）。
2. 每行优惠，顺序固定：先**百分比折扣**，再**固定金额减免**（源币种）。
3. 每行：乘以输入的**有理汇率**换算到目标币种。
4. 每行：对换算结果按指定小数位做**半偶舍入**（banker's rounding）。
5. **合计 = 各行舍入后金额之和**（不是整体精确值再舍入）。

## 退款

对原订单**剩余（未退）行重新执行完整结算流程**，
`退款额 = 原订单合计 − 剩余项合计`（两者均为逐行舍入后的和，差值精确）。

## 舍入证据

每次舍入输出 `RoundEvidence`：舍入前精确值（分子/分母）、缩放后的
分子/分母、截断商、余数、余数与半单位的关系（less/exactly/greater）、
最终舍入结果。可用 `ScaledNum = Quotient×ScaledDen + Remainder` 自校验。

## 独立核对

测试中以 `math/big.Rat` 构建**独立的任意精度分数模型**（独立的半偶舍入、
独立的优惠/换算复算），逐行对照精确值、舍入结果与合计。

## 运行测试

```sh
go test ./...
```

## 实测结果（go1.27.1 linux/amd64）

```
=== RUN   TestFracArithmeticVsRatModel
--- PASS: TestFracArithmeticVsRatModel (0.00s)
=== RUN   TestRoundHalfEvenKnownCases
--- PASS: TestRoundHalfEvenKnownCases (0.00s)
=== RUN   TestRoundHalfEvenVsRatModel
--- PASS: TestRoundHalfEvenVsRatModel (0.01s)
=== RUN   TestSettleMatchesIndependentModel
--- PASS: TestSettleMatchesIndependentModel (0.00s)
=== RUN   TestDiscountOrderPercentThenFixed
--- PASS: TestDiscountOrderPercentThenFixed (0.00s)
=== RUN   TestRefundRecomputesRemainingAndDiffs
    settle_test.go:256: original=50049 remaining=41543 refund=8506 (drop line alone rounds to 8506)
--- PASS: TestRefundRecomputesRemainingAndDiffs (0.00s)
=== RUN   TestRefundErrors
--- PASS: TestRefundErrors (0.00s)
PASS
ok  	settle/settle	0.035s
```
