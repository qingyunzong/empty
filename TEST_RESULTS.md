# 测试结果记录

- 日期: 2026-10-05 18:07:00 CST
- 环境: go version go1.27.1 linux/amd64, linux/amd64
- 命令: `go test ./... -count=1 -v`（GOCACHE=/tmp/gocache，默认缓存目录只读）
- 仅使用 Go 标准库（go.mod 无外部依赖）

```
=== RUN   TestOutOfOrderImportMatchesFullHistoryModel
--- PASS: TestOutOfOrderImportMatchesFullHistoryModel (0.03s)
=== RUN   TestModelSanity
--- PASS: TestModelSanity (0.00s)
=== RUN   TestDecisionUsesLatestRoundNotAnyPass
--- PASS: TestDecisionUsesLatestRoundNotAnyPass (0.00s)
=== RUN   TestSameRoundConflictRejected
--- PASS: TestSameRoundConflictRejected (0.00s)
=== RUN   TestLowerSeqConflictDisplacesEarlierAccept
--- PASS: TestLowerSeqConflictDisplacesEarlierAccept (0.00s)
=== RUN   TestGoverningBaselineIsLatestPublicValid
--- PASS: TestGoverningBaselineIsLatestPublicValid (0.00s)
=== RUN   TestDuplicateBaselineHighestSeqWins
--- PASS: TestDuplicateBaselineHighestSeqWins (0.00s)
=== RUN   TestMismatchesListedSeparately
--- PASS: TestMismatchesListedSeparately (0.00s)
=== RUN   TestOutOfOrderRounds
--- PASS: TestOutOfOrderRounds (0.00s)
=== RUN   TestSourceSummary
--- PASS: TestSourceSummary (0.00s)
=== RUN   TestDuplicateSeqRejected
--- PASS: TestDuplicateSeqRejected (0.00s)
=== RUN   TestUndecided
--- PASS: TestUndecided (0.00s)
PASS
ok  	resultdb	0.037s
```

结果: 12/12 通过，0 失败。
