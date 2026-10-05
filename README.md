# pool

Generic, capacity-bounded object pool for Go (standard library only).

## Semantics

- **Clean on return**: `Return` resets the object first; if reset fails, the
  object is destroyed and its capacity slot is released.
- **Close**: idle objects are destroyed, loans returned after `Close` are
  destroyed instead of pooled, and pending waiters fail with `ErrClosed`.
- **Cancellable waiters**: `Borrow` blocks on a full pool until an object or
  slot frees up, the pool closes, or the caller's context is cancelled.
- **No slot leaks**: a slot is reserved before producing; produce failures
  and concurrent closes always release or transfer the reservation.
- **Exactly-once destroy**: every produced object is destroyed exactly once.

## Test results

`go test ./...` (go1.27.1 linux/amd64, 2026-10-05):

```
ok  	pool	0.050s
```

`go test ./... -race -count=1 -v`:

```
--- PASS: TestResetFailureDestroysAndReleasesSlot (0.00s)
--- PASS: TestCloseDestroysReturnedLoans (0.00s)
--- PASS: TestWaiterCancellation (0.04s)
--- PASS: TestProduceFailureReleasesSlot (0.00s)
--- PASS: TestBarrierConcurrency (0.00s)   # maxLive=8 (capacity 8)
--- PASS: TestBarrierCancellationStorm (0.00s)
PASS
ok  	pool	1.064s
```

`go test ./... -race -count=5 -run 'Barrier|Waiter'`: `ok pool 1.262s`
(no flakes, no data races).
