# Test Results

Environment: go1.27.1 linux/amd64, run on 2026-10-05.

## `go test ./...`

```
ok  	statestore	0.008s
```

## `go test -race -count=1 -v ./...`

```
=== RUN   TestConcurrentSameExpectedVersion
--- PASS: TestConcurrentSameExpectedVersion (0.00s)
=== RUN   TestVersionChainUnderConcurrency
--- PASS: TestVersionChainUnderConcurrency (0.01s)
=== RUN   TestShortWriteNotPublished
--- PASS: TestShortWriteNotPublished (0.00s)
=== RUN   TestCrashAfterPersistBeforePublish
--- PASS: TestCrashAfterPersistBeforePublish (0.00s)
=== RUN   TestReplayIgnoresTornAndCorruptTail
--- PASS: TestReplayIgnoresTornAndCorruptTail (0.00s)
PASS
ok  	statestore	1.024s
```

## `go test -race -count=5 ./...` (stability re-run)

```
ok  	statestore	1.096s
```

All tests pass, including with the race detector enabled.
