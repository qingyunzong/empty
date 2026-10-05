# Test Results

```
$ go test ./... -count=1 -v
=== RUN   TestShortestPathCertificate
--- PASS: TestShortestPathCertificate (0.00s)
=== RUN   TestCapacityOverflowBlocksFiring
--- PASS: TestCapacityOverflowBlocksFiring (0.00s)
=== RUN   TestUnreachableTargetYieldsFullClosure
--- PASS: TestUnreachableTargetYieldsFullClosure (0.00s)
=== RUN   TestClosureDeduplicatesStates
--- PASS: TestClosureDeduplicatesStates (0.00s)
=== RUN   TestPrioritySemantics
--- PASS: TestPrioritySemantics (0.00s)
=== RUN   TestResetArcAfterUnifiedConsumption
--- PASS: TestResetArcAfterUnifiedConsumption (0.00s)
=== RUN   TestGuard
--- PASS: TestGuard (0.00s)
=== RUN   TestFairCycleFound
--- PASS: TestFairCycleFound (0.00s)
=== RUN   TestFairCycleWithSelfLoop
--- PASS: TestFairCycleWithSelfLoop (0.00s)
=== RUN   TestNoFairCycleWhenExitIsOneWay
--- PASS: TestNoFairCycleWhenExitIsOneWay (0.00s)
=== RUN   TestNaiveBFSAndIndependentEnumerationCrossCheck
--- PASS: TestNaiveBFSAndIndependentEnumerationCrossCheck (0.00s)
=== RUN   TestCertificateRejectsTampering
--- PASS: TestCertificateRejectsTampering (0.00s)
PASS
ok  	petri	0.009s
```

Recorded: 2026-10-05 05:37 UTC, go version: go1.27.1. Note: GOCACHE set to /tmp/gocache because the default cache dir is read-only in this environment.
