# 测试结果记录

日期: 2026-10-05 15:30:04 CST
Go 版本: go version go1.27.1 linux/amd64

## `go test ./...`

```
=== RUN   TestExhaustiveInterleavings
    model_test.go:305: exhaustively checked 3111696 scripts of depth 4 over 42 ops
--- PASS: TestExhaustiveInterleavings (3.19s)
=== RUN   TestRandomizedInterleavings
--- PASS: TestRandomizedInterleavings (0.01s)
=== RUN   TestModelSanity
--- PASS: TestModelSanity (0.00s)
=== RUN   TestBasicFireAndClockPosition
--- PASS: TestBasicFireAndClockPosition (0.00s)
=== RUN   TestSameTickCreationOrder
--- PASS: TestSameTickCreationOrder (0.00s)
=== RUN   TestStopBeforeFire
--- PASS: TestStopBeforeFire (0.00s)
=== RUN   TestStopAfterFireReturnsFalse
--- PASS: TestStopAfterFireReturnsFalse (0.00s)
=== RUN   TestResetMasksEnqueuedEvent
--- PASS: TestResetMasksEnqueuedEvent (0.00s)
=== RUN   TestResetToSameDeadlineFiresOnce
--- PASS: TestResetToSameDeadlineFiresOnce (0.00s)
=== RUN   TestResetAfterFire
--- PASS: TestResetAfterFire (0.00s)
=== RUN   TestCallbackResetsItself
--- PASS: TestCallbackResetsItself (0.00s)
=== RUN   TestCallbackResetsItselfWithZeroDelay
--- PASS: TestCallbackResetsItselfWithZeroDelay (0.00s)
=== RUN   TestCallbackStopsOtherTimer
--- PASS: TestCallbackStopsOtherTimer (0.00s)
=== RUN   TestCallbackResetsOtherTimer
--- PASS: TestCallbackResetsOtherTimer (0.00s)
=== RUN   TestSameTickOrderWithReset
--- PASS: TestSameTickOrderWithReset (0.00s)
=== RUN   TestZeroDelayFiresOnAdvanceZero
--- PASS: TestZeroDelayFiresOnAdvanceZero (0.00s)
=== RUN   TestNegativeDelayPanics
--- PASS: TestNegativeDelayPanics (0.00s)
PASS
ok  	timerlib	3.197s
```
