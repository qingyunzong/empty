# ratelimit

A token-bucket rate limiter (Go standard library only) that reserves
integer token costs for future ticks on a virtual clock.

## Semantics

- **Virtual clock.** Time is integer ticks from a `Clock`; `ManualClock`
  is provided for tests and simulations.
- **Exact-remainder refill.** The bucket refills at `rateNum/rateDen`
  tokens per tick. The fractional remainder is carried exactly and never
  rounded away; tokens beyond the capacity are discarded.
- **Reservations.** `Reserve(cost, notBefore)` schedules a claim at the
  earliest feasible tick `>= max(now, notBefore)`, appended after all
  pending reservations. Tokens are deducted at execution, not at
  reservation time. Reservations on the same tick consume tokens in
  reservation (sequence) order.
- **Cancel and re-pack.** `Cancel` removes a pending reservation and
  refunds its cost, then re-packs the remaining pending reservations to
  their earliest feasible ticks. Re-packing never moves a reservation
  before the current tick, so it can never cross an already executed
  reservation.
- **Lazy execution.** Due reservations execute (in `(At, Seq)` order)
  whenever the limiter observes the clock; `Sync` forces the check and
  returns what executed.

## Example

```go
clock := ratelimit.NewManualClock(0)
l := ratelimit.NewLimiter(10, 1, 2, clock) // capacity 10, 0.5 token/tick

a, _ := l.Reserve(10, 10) // a.At == 10
b, _ := l.Reserve(4, 0)   // b.At == 18 (appended after a)
refund, _ := l.Cancel(a)  // refund == 10, b re-packs to tick 0
clock.Advance(1)
executed := l.Sync()      // b executed at tick 0
```

## Testing

`go test ./...` runs unit tests plus a cross-check that drives the
limiter and an independent naive per-tick simulation through randomized
operation sequences, comparing reservation ticks, cancel refunds,
execution order, and exact (whole + remainder) balances after every step.
