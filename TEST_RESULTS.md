# go test ./... 实际结果

- 日期: 2026-10-05 02:40:26 CST
- Go 版本: go version go1.27.1 linux/amd64

```
=== RUN   TestHalfOpenWindows
--- PASS: TestHalfOpenWindows (0.00s)
=== RUN   TestWatermarkNeverRetreats
--- PASS: TestWatermarkNeverRetreats (0.00s)
=== RUN   TestLatenessBoundary
--- PASS: TestLatenessBoundary (0.00s)
=== RUN   TestCorrectionRevokesOldContribution
--- PASS: TestCorrectionRevokesOldContribution (0.00s)
=== RUN   TestCorrectionOfUnknownIDAppliesAsNew
--- PASS: TestCorrectionOfUnknownIDAppliesAsNew (0.00s)
=== RUN   TestLateCorrectionRejectedKeepsOldContribution
--- PASS: TestLateCorrectionRejectedKeepsOldContribution (0.00s)
=== RUN   TestOutOfOrderVsFullRecompute
=== RUN   TestOutOfOrderVsFullRecompute/seed=1
=== RUN   TestOutOfOrderVsFullRecompute/seed=7
=== RUN   TestOutOfOrderVsFullRecompute/seed=42
=== RUN   TestOutOfOrderVsFullRecompute/seed=2026
--- PASS: TestOutOfOrderVsFullRecompute (0.00s)
    --- PASS: TestOutOfOrderVsFullRecompute/seed=1 (0.00s)
    --- PASS: TestOutOfOrderVsFullRecompute/seed=7 (0.00s)
    --- PASS: TestOutOfOrderVsFullRecompute/seed=42 (0.00s)
    --- PASS: TestOutOfOrderVsFullRecompute/seed=2026 (0.00s)
PASS
ok  	winagg	0.009s
```
