# Test Results

Command: `go test ./... -count=1 -v` (GOCACHE/GOPATH pointed at /tmp because the
default cache dir is read-only in this sandbox). Also `go vet ./...` — clean.

Recorded 2026-10-05, go1.27.1 linux/amd64:

```
=== RUN   TestReplayAgainstSetModel
=== RUN   TestReplayAgainstSetModel/seed=1
=== RUN   TestReplayAgainstSetModel/seed=7
=== RUN   TestReplayAgainstSetModel/seed=42
=== RUN   TestReplayAgainstSetModel/seed=2024
=== RUN   TestReplayAgainstSetModel/seed=999983
--- PASS: TestReplayAgainstSetModel (0.01s)
    --- PASS: TestReplayAgainstSetModel/seed=1 (0.00s)
    --- PASS: TestReplayAgainstSetModel/seed=7 (0.00s)
    --- PASS: TestReplayAgainstSetModel/seed=42 (0.00s)
    --- PASS: TestReplayAgainstSetModel/seed=2024 (0.00s)
    --- PASS: TestReplayAgainstSetModel/seed=999983 (0.00s)
=== RUN   TestOutOfOrderAcksAdvanceOnlyContiguousPrefix
--- PASS: TestOutOfOrderAcksAdvanceOnlyContiguousPrefix (0.00s)
=== RUN   TestReclaimUsesMinActivePrefix
--- PASS: TestReclaimUsesMinActivePrefix (0.00s)
=== RUN   TestReclaimNoActiveConsumersIsNoop
--- PASS: TestReclaimNoActiveConsumersIsNoop (0.00s)
=== RUN   TestCancelKeepsPersistentExitRecord
--- PASS: TestCancelKeepsPersistentExitRecord (0.00s)
=== RUN   TestReplayStartsAtPrefixAndSkipsReclaimed
--- PASS: TestReplayStartsAtPrefixAndSkipsReclaimed (0.00s)
=== RUN   TestUnknownConsumerErrors
--- PASS: TestUnknownConsumerErrors (0.00s)
PASS
ok  	seglib	0.014s
```
