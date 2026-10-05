# go test ./... 实际结果

```
=== RUN   TestReconnectIncrementsGeneration
--- PASS: TestReconnectIncrementsGeneration (0.00s)
=== RUN   TestStaleGenerationInFlightRejected
--- PASS: TestStaleGenerationInFlightRejected (0.00s)
=== RUN   TestDuplicateSeqReturnsOriginalResult
--- PASS: TestDuplicateSeqReturnsOriginalResult (0.00s)
=== RUN   TestDisconnectDoesNotRollBack
--- PASS: TestDisconnectDoesNotRollBack (0.00s)
=== RUN   TestInterleavedEventsCurrentGenerationOnly
--- PASS: TestInterleavedEventsCurrentGenerationOnly (0.00s)
=== RUN   TestConcurrentInFlightAcrossReconnect
--- PASS: TestConcurrentInFlightAcrossReconnect (0.00s)
PASS
ok  	sessionstore	(cached)
```
