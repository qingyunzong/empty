# 测试结果记录

环境:go1.27.1 linux/amd64,仅使用 Go 标准库。

## `go test ./...`(2026-10-05)

```
ok  	statestore/store	0.007s
```

## `go test ./... -race -count=1 -v`

```
--- PASS: TestConcurrentSameExpectedVersionOnlyOneWins (0.00s)
--- PASS: TestPersistedBeforeVisible (0.00s)
--- PASS: TestShortWriteNotPublished (0.00s)
--- PASS: TestWriteErrorNotPublished (0.00s)
--- PASS: TestCrashDuringSyncNotPublished (0.00s)
--- PASS: TestRecoveryIgnoresTornTail (0.00s)
--- PASS: TestRecoveryStopsAtCorruptFrame (0.00s)
--- PASS: TestRecoveryRoundTrip (0.00s)
PASS
ok  	statestore/store	1.022s
```

## 并发压力复跑 `go test ./store/ -run TestConcurrent -race -count=50`

```
ok  	statestore/store	1.121s
```

8 个测试全部通过,race detector 无告警,并发竞争测试 50 次复跑稳定。
