# go test ./... 实际结果

日期: 2026-10-06 01:52:05 CST  Go: go version go1.27.1 linux/amd64

```
=== RUN   TestExecuteSuccess
--- PASS: TestExecuteSuccess (0.00s)
=== RUN   TestPreconditionFailureRollsBackInReverse
--- PASS: TestPreconditionFailureRollsBackInReverse (0.00s)
=== RUN   TestExternalModificationNotOverwritten
--- PASS: TestExternalModificationNotOverwritten (0.00s)
=== RUN   TestPendingTailSaveLoad
--- PASS: TestPendingTailSaveLoad (0.00s)
=== RUN   TestExhaustiveFaultInjection
=== RUN   TestExhaustiveFaultInjection/failAt=0
=== RUN   TestExhaustiveFaultInjection/failAt=1
=== RUN   TestExhaustiveFaultInjection/failAt=2
=== RUN   TestExhaustiveFaultInjection/failAt=3
=== RUN   TestExhaustiveFaultInjection/failAt=4
=== RUN   TestExhaustiveFaultInjection/failAt=5
=== RUN   TestExhaustiveFaultInjection/failAt=6
=== RUN   TestExhaustiveFaultInjection/failAt=7
=== RUN   TestExhaustiveFaultInjection/failAt=8
=== RUN   TestExhaustiveFaultInjection/failAt=9
=== RUN   TestExhaustiveFaultInjection/failAt=10
=== RUN   TestExhaustiveFaultInjection/failAt=11
--- PASS: TestExhaustiveFaultInjection (0.00s)
    --- PASS: TestExhaustiveFaultInjection/failAt=0 (0.00s)
    --- PASS: TestExhaustiveFaultInjection/failAt=1 (0.00s)
    --- PASS: TestExhaustiveFaultInjection/failAt=2 (0.00s)
    --- PASS: TestExhaustiveFaultInjection/failAt=3 (0.00s)
    --- PASS: TestExhaustiveFaultInjection/failAt=4 (0.00s)
    --- PASS: TestExhaustiveFaultInjection/failAt=5 (0.00s)
    --- PASS: TestExhaustiveFaultInjection/failAt=6 (0.00s)
    --- PASS: TestExhaustiveFaultInjection/failAt=7 (0.00s)
    --- PASS: TestExhaustiveFaultInjection/failAt=8 (0.00s)
    --- PASS: TestExhaustiveFaultInjection/failAt=9 (0.00s)
    --- PASS: TestExhaustiveFaultInjection/failAt=10 (0.00s)
    --- PASS: TestExhaustiveFaultInjection/failAt=11 (0.00s)
PASS
ok  	planexec	(cached)
```
