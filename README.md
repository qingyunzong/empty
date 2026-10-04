# msglib

Causally ordered message buffer with a payload-byte memory budget. Go
standard library only.

## Semantics

- **Memory accounting**: memory is accounted in payload bytes; accepted but
  undelivered messages — including causally blocked ones — consume budget.
- **Rejection**: a receive that would exceed the budget fails with
  `*OverBudgetError` (`errors.Is(err, ErrOverBudget)`); the receive vector
  and memory accounting are left untouched.
- **Release**: delivered messages release their bytes immediately; a node's
  own sends are delivered locally and never consume buffer memory.
- **Dependency reporting**: `Missing(id)` returns the direct dependency gaps
  of a blocked message; `Report(id)` returns the complete chain, recursing
  through buffered dependencies (`DepChain{Absent, Pending, Children}`).
- **Duplicates**: re-receiving a delivered or buffered message is a free
  no-op.

## Verification

Randomized send/receive workloads are cross-checked against a full causal
reference model (`model_test.go`): budget conservation (`Used` equals the
exact pending payload bytes, never exceeding the limit), receive vectors,
rejection semantics, causal delivery order, and full memory release after
complete delivery.

## Test results

`go test ./... -v -count=1` (go1.27.1 linux/amd64):

```
=== RUN   TestRandomizedModelCrossCheck
    model_test.go:179: ops=20000 rejections=9797 sent=6655
--- PASS: TestRandomizedModelCrossCheck (0.21s)
=== RUN   TestRandomizedDrainReleasesAllMemory
--- PASS: TestRandomizedDrainReleasesAllMemory (0.32s)
=== RUN   TestPayloadByteAccounting
--- PASS: TestPayloadByteAccounting (0.00s)
=== RUN   TestBlockedItemsConsumeBudget
--- PASS: TestBlockedItemsConsumeBudget (0.00s)
=== RUN   TestRejectionLeavesVectorAndMemoryUntouched
--- PASS: TestRejectionLeavesVectorAndMemoryUntouched (0.00s)
=== RUN   TestReleaseAfterDelivery
--- PASS: TestReleaseAfterDelivery (0.00s)
=== RUN   TestDuplicateReceiveIsFree
--- PASS: TestDuplicateReceiveIsFree (0.00s)
=== RUN   TestMissingChainReport
--- PASS: TestMissingChainReport (0.00s)
PASS
ok  	msglib	0.535s
```

`go test ./... -race -count=1`: `ok msglib 4.836s`
