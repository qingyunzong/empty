# Test Results

Date: 2026-10-07 02:22:59 UTC

## `go test ./...`

```
ok  	ratelimit	0.053s
```

## `go test -v ./...` (summary)

```
--- PASS: TestExactRemainderRefill (0.00s)
--- PASS: TestSameTickReservationOrder (0.00s)
--- PASS: TestCancelRepacksWithoutCrossingExecuted (0.00s)
--- PASS: TestCancelRefundAndStatus (0.00s)
--- PASS: TestCapacityCapAndValidation (0.00s)
--- PASS: TestNotBeforeHonored (0.00s)
--- PASS: TestZeroRateNeverSatisfiable (0.00s)
--- PASS: TestCrossCheckPerTickModel (0.06s)
PASS
ok  	ratelimit	0.061s
```
