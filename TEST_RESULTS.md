# 测试结果记录

- 日期：2026-10-05 02:17:01 CST
- 工具链：go version go1.27.1 linux/amd64（linux/amd64）
- 命令：`go test ./...`（另以 `-count=1` 禁用缓存复跑验证）

## 实际输出

```
ok  	settle	0.090s
```

## 逐测试明细（go test -v -count=1）

| 测试 | 结果 |
| --- | --- |
| TestParseFrac | PASS |
| TestRoundHalfEven | PASS |
| TestDecimal | PASS |
| TestModelCrossCheckFixed (order0/1/2) | PASS |
| TestModelCrossCheckRandom（500 组随机订单 + 随机退款，对比 big.Rat 独立模型） | PASS |
| TestDiscountExplicitOrder | PASS |
| TestOrderLevelAllocation | PASS |
| TestSettleGolden | PASS |
| TestRefundRecomputesRemaining | PASS |
| TestRefundErrors | PASS |
| TestEvidenceJSON | PASS |

`go vet ./...`：通过，无告警。`gofmt -l .`：无输出（全部已格式化）。
