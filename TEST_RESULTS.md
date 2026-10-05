# Test Results

Command: `go test ./... -v -count=1` (go1.27.1 linux/amd64)
Date: 2026-10-05 15:59:21 CST

```
=== RUN   TestExactRemainderRefill
--- PASS: TestExactRemainderRefill (0.00s)
=== RUN   TestIntegerRate
--- PASS: TestIntegerRate (0.00s)
=== RUN   TestSameTickReservationOrder
--- PASS: TestSameTickReservationOrder (0.00s)
=== RUN   TestCancelRefundsAndRetimes
--- PASS: TestCancelRefundsAndRetimes (0.00s)
=== RUN   TestCancelExecutedFails
--- PASS: TestCancelExecutedFails (0.00s)
=== RUN   TestRetimeNeverCrossesExecuted
--- PASS: TestRetimeNeverCrossesExecuted (0.00s)
=== RUN   TestBurstCap
--- PASS: TestBurstCap (0.00s)
=== RUN   TestInvalidCost
--- PASS: TestInvalidCost (0.00s)
=== RUN   TestDelay
--- PASS: TestDelay (0.00s)
=== RUN   TestAgainstTickModel
=== RUN   TestAgainstTickModel/rate1_burst10
=== RUN   TestAgainstTickModel/rate5/2_burst20
=== RUN   TestAgainstTickModel/rate2/3_burst4
=== RUN   TestAgainstTickModel/rate7/5_burst9
=== RUN   TestAgainstTickModel/rate3_burst1
--- PASS: TestAgainstTickModel (0.02s)
    --- PASS: TestAgainstTickModel/rate1_burst10 (0.00s)
    --- PASS: TestAgainstTickModel/rate5/2_burst20 (0.00s)
    --- PASS: TestAgainstTickModel/rate2/3_burst4 (0.00s)
    --- PASS: TestAgainstTickModel/rate7/5_burst9 (0.00s)
    --- PASS: TestAgainstTickModel/rate3_burst1 (0.00s)
PASS
ok  	ratelimit	0.025s
```

`go test -race ./...` also passes (ok ratelimit 1.307s).
