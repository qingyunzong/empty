# Test Results

Environment: `go version go1.27.1 linux/amd64`
(`GOCACHE`/`GOPATH` pointed at `/tmp` because `$HOME/.cache` is read-only.)

## `go test ./...` (2026-10-05)

```
$ go test -count=1 ./...
ok  	dualindex	0.062s
exit=0
```

## `go vet ./...`

clean (no output, exit 0)

## `gofmt -l .`

clean (no files listed)

## `go test -race -count=1 -v ./...`

```
=== RUN   TestQueryMatchesRawScan
--- PASS: TestQueryMatchesRawScan (0.00s)
=== RUN   TestFaultInjectionKeepsOldGeneration
=== RUN   TestFaultInjectionKeepsOldGeneration/persist_content
=== RUN   TestFaultInjectionKeepsOldGeneration/persist_path
=== RUN   TestFaultInjectionKeepsOldGeneration/publish
--- PASS: TestFaultInjectionKeepsOldGeneration (0.01s)
    --- PASS: TestFaultInjectionKeepsOldGeneration/persist_content (0.00s)
    --- PASS: TestFaultInjectionKeepsOldGeneration/persist_path (0.00s)
    --- PASS: TestFaultInjectionKeepsOldGeneration/publish (0.00s)
=== RUN   TestOldGenerationDeletedAfterReaderRelease
--- PASS: TestOldGenerationDeletedAfterReaderRelease (0.00s)
=== RUN   TestConcurrentReadersSeeConsistentGeneration
--- PASS: TestConcurrentReadersSeeConsistentGeneration (0.04s)
=== RUN   TestReopenRecoversPublishedGeneration
--- PASS: TestReopenRecoversPublishedGeneration (0.00s)
PASS
ok  	dualindex	1.071s
```

All 5 tests (7 including subtests) pass, including under the race detector.
