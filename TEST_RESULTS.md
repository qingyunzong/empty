# 测试结果记录

日期: 2026-10-05 04:05:52 CST
Go: go version go1.27.1 linux/amd64
模块: idalloc（仅标准库）

## $ go test ./...
```
ok  	idalloc	2.758s
exit=0
```

## $ go test -race ./...
```
ok  	idalloc	36.963s
exit=0
```

## $ go test -v -count=1 ./...
```
=== RUN   TestFaultInjectionUniqueness
=== RUN   TestFaultInjectionUniqueness/seed=1
    chaos_test.go:166: crashes=498 acquires=1010 transfers=959 issue-ops=2031 delivered=804 reserved=6279 holes=5475
=== RUN   TestFaultInjectionUniqueness/seed=7
    chaos_test.go:166: crashes=483 acquires=1024 transfers=996 issue-ops=1980 delivered=767 reserved=6546 holes=5779
=== RUN   TestFaultInjectionUniqueness/seed=20261005
    chaos_test.go:166: crashes=459 acquires=1005 transfers=1005 issue-ops=1990 delivered=831 reserved=6253 holes=5422
--- PASS: TestFaultInjectionUniqueness (3.47s)
    --- PASS: TestFaultInjectionUniqueness/seed=1 (1.04s)
    --- PASS: TestFaultInjectionUniqueness/seed=7 (1.28s)
    --- PASS: TestFaultInjectionUniqueness/seed=20261005 (1.15s)
=== RUN   TestNaiveAckBeforePersistDuplicates
--- PASS: TestNaiveAckBeforePersistDuplicates (0.00s)
=== RUN   TestAllocatePersistsAcrossRestart
--- PASS: TestAllocatePersistsAcrossRestart (0.00s)
=== RUN   TestNodeRestartContinuesUnconsumedTail
--- PASS: TestNodeRestartContinuesUnconsumedTail (0.00s)
=== RUN   TestTransferClosesOldGenerationFirst
--- PASS: TestTransferClosesOldGenerationFirst (0.00s)
=== RUN   TestCrashAfterPersistKeepsCursor
--- PASS: TestCrashAfterPersistKeepsCursor (0.00s)
=== RUN   TestFailedPersistDoesNotConsumeID
--- PASS: TestFailedPersistDoesNotConsumeID (0.00s)
=== RUN   TestConcurrentIssueIsUnique
--- PASS: TestConcurrentIssueIsUnique (0.02s)
PASS
ok  	idalloc	3.498s
exit=0
```
