# timer

A deterministic timer library on an integer logical clock.

- **Logical clock**: time only moves via `AdvanceTo(t)`; moving backward panics.
- **Reschedule & cancel**: `Reschedule` moves a live timer to a new deadline,
  `Cancel` withdraws it.
- **Same-tick order**: timers due at the same tick fire in ascending ID order.
- **Re-registration**: a callback that schedules a timer due at the tick being
  processed appends it to the end of the current round (same `AdvanceTo` call).
- **Call budget**: `New(budget)` caps callbacks per `AdvanceTo`, so callbacks that
  re-register current-tick timers cannot loop forever; `AdvanceTo` reports
  `exhausted` and a further call resumes.
- **Generations**: every `Reschedule` bumps the timer's generation; operations
  through an older `Handle` are stale no-ops (as are stale heap entries).
- **Event log**: every schedule/reschedule/cancel/fire is recorded; `Events()`
  returns a copy for reference verification.

Run the tests:

```sh
go test ./...
```
