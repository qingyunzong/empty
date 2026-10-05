# Test Results

Recorded: 2026-10-05, go1.27.1 linux/amd64

## `go test ./... -count=1 -v`

```
=== RUN   TestSingleIntervalNoCost
--- PASS: TestSingleIntervalNoCost (0.00s)
=== RUN   TestSpillForcedByPressure
--- PASS: TestSpillForcedByPressure (0.00s)
=== RUN   TestSpillAndReload
--- PASS: TestSpillAndReload (0.00s)
=== RUN   TestCallReservedForcesSpill
--- PASS: TestCallReservedForcesSpill (0.00s)
=== RUN   TestCallReservedSubset
--- PASS: TestCallReservedSubset (0.00s)
=== RUN   TestInfeasibleTooManyStarts
--- PASS: TestInfeasibleTooManyStarts (0.00s)
=== RUN   TestInfeasibleStartAtFullyReservedCall
--- PASS: TestInfeasibleStartAtFullyReservedCall (0.00s)
=== RUN   TestSixteenIntervals
--- PASS: TestSixteenIntervals (0.01s)
=== RUN   TestValidationLimits
--- PASS: TestValidationLimits (0.00s)
=== RUN   TestDPvsBruteForceRandom
--- PASS: TestDPvsBruteForceRandom (3.53s)
=== RUN   TestCertificateDetectsTampering
--- PASS: TestCertificateDetectsTampering (0.00s)
PASS
ok  	regalloc	3.549s
?   	regalloc/cmd/regalloc	[no test files]
```

## `go vet ./...`

```
(no output, exit 0)
```

## `gofmt -l .`

```
(no output, all files formatted)
```
