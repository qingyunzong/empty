# go test ./... 实际运行结果

命令：`GOCACHE=/tmp/gocache GOTMPDIR=/tmp go test ./... -v -count=1`

```
=== RUN   TestHandComputed
--- PASS: TestHandComputed (0.00s)
=== RUN   TestRationalEfficiencyExact
--- PASS: TestRationalEfficiencyExact (0.00s)
=== RUN   TestSellBack
--- PASS: TestSellBack (0.00s)
=== RUN   TestInfeasible
--- PASS: TestInfeasible (0.00s)
=== RUN   TestTooManySlots
--- PASS: TestTooManySlots (0.00s)
=== RUN   TestDPvsBruteForceRandom
--- PASS: TestDPvsBruteForceRandom (1.86s)
=== RUN   TestTwelveSlotsVsBruteForce
--- PASS: TestTwelveSlotsVsBruteForce (0.14s)
=== RUN   TestVerifyRejectsTampering
--- PASS: TestVerifyRejectsTampering (0.01s)
PASS
ok  	essplan	2.029s
```
