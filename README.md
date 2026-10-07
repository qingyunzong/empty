# railplan

Track-occupancy planning library in Go.

- Trains reserve half-open intervals `[Start, End)` on named tracks; the
  time domain is `[0, 1000)`. Conflicts happen only between overlapping
  intervals on the same track.
- `RescheduleWhole` replaces a train's whole layout atomically: the
  train's own old reservations are excluded from the conflict check, and
  any failure keeps the old layout untouched.
- `EarliestShift(train, minDelta)` finds the earliest feasible whole
  shift of a train's layout. The interval-based search is verified
  against a per-moment brute-force search in the tests.
- `AtomicReschedule` applies a multi-train batch (e.g. swapping slots)
  atomically: the batch's old reservations are removed from
  consideration before all new reservations are checked.
- `Intent` is a persistent, crash-recoverable batch reschedule. After a
  mid-way failure, `Recover` restores either the whole old or the whole
  new batch layout — never a partial, per-train mix.

Run the tests:

```sh
go test ./...
```
