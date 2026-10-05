# 测试结果记录

日期: 2026-10-05, Go 1.27.1 linux/amd64

## `go test ./...`

```
ok  	example.com/modlib/modlib	0.033s
```

## `go test ./... -race -v -count=1`

```
=== RUN   TestOldGenTasksFinishAfterSwitch
--- PASS: TestOldGenTasksFinishAfterSwitch (0.00s)
=== RUN   TestNewTasksBindOnlyToNewGen
--- PASS: TestNewTasksBindOnlyToNewGen (0.00s)
=== RUN   TestWaitOldSealedAtCallTime
--- PASS: TestWaitOldSealedAtCallTime (0.00s)
=== RUN   TestWaitOldIgnoresCurrentGeneration
--- PASS: TestWaitOldIgnoresCurrentGeneration (0.00s)
=== RUN   TestFinishCancelIdempotent
--- PASS: TestFinishCancelIdempotent (0.00s)
=== RUN   TestRandomHistoryAgainstModel
=== RUN   TestRandomHistoryAgainstModel/seed=1
=== RUN   TestRandomHistoryAgainstModel/seed=7
=== RUN   TestRandomHistoryAgainstModel/seed=42
=== RUN   TestRandomHistoryAgainstModel/seed=20261005
=== RUN   TestRandomHistoryAgainstModel/seed=987654321
--- PASS: TestRandomHistoryAgainstModel (0.20s)
    --- PASS: TestRandomHistoryAgainstModel/seed=1 (0.05s)
    --- PASS: TestRandomHistoryAgainstModel/seed=7 (0.04s)
    --- PASS: TestRandomHistoryAgainstModel/seed=42 (0.04s)
    --- PASS: TestRandomHistoryAgainstModel/seed=20261005 (0.04s)
    --- PASS: TestRandomHistoryAgainstModel/seed=987654321 (0.04s)
=== RUN   TestConcurrentRandomOps
--- PASS: TestConcurrentRandomOps (0.00s)
PASS
ok  	example.com/modlib/modlib	1.219s
```
