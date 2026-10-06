# readwait

Follower-side read synchronization for a commit/apply log (e.g. Raft-like
stores), with deterministic, controllable time events for tests.

## Semantics

- **Register-then-wait reads**: `Replica.Read` first captures the current
  commit index as the wait target, registers a waiter in the `Tracker`, and
  returns only after the applied index reaches that target.
- **Explicit timeout**: a deadline miss returns `*NotAppliedError` (carrying
  `Target` and `Applied`) and no value — never a stale read.
- **Cancellation**: canceling the context removes the waiter and returns
  `ctx.Err()`.
- **Monotonic applied index**: `NotifyApplied` ignores lower indexes, and
  `InstallSnapshot` rejects any snapshot at or behind the current applied
  index, so installing a snapshot never regresses it.
- **Batch wake-up**: a single `NotifyApplied`/`ApplyTo` wakes every waiter
  whose target is satisfied, in one batch.

## Controllable events

`ManualClock` fires timers only when `Advance` moves it past their deadline
(synchronously, in deadline order), so tests deterministically verify
same-moment application, timeout, and batch wake-up. Production code uses
`RealClock` (the default when nil is passed).

## Test

```sh
go test ./...
```
