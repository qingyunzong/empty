# desim

A small discrete-event simulation library using only the Go standard library.

## Semantics

- **Events derive successors.** Handlers receive a `Context` and may call
  `ctx.Schedule` / `ctx.At` to enqueue successor events at any future time.
- **Stop condition is quiescence, not an empty queue.** A run ends only when
  the event queue is empty **and** no registered `Component` reports
  `Enabled(now)`. A momentarily empty queue never stops the run while a
  component can still fire; component actions may schedule new events, which
  are then processed normally.
- **Budget overruns return evidence.** `Run(Budget)` stops early when
  `MaxSteps` or `MaxTime` is exceeded. The returned `Result.Backlog` lists
  the pending events (time + label, sorted) and the names of components that
  were still ready to fire — concrete evidence of the remaining work.
- **Snapshots include the RNG.** `Sim.Snapshot` captures the clock, pending
  events, the deterministic RNG state, every component's state, and the
  trace. `Restore` rebuilds a simulation that evolves bit-for-bit
  identically to an uninterrupted run from scratch (verified by
  `TestSnapshotRestoreMatchesFullRun`).

## Usage

```go
sim := desim.New(42)              // seed the deterministic RNG
sim.AddComponent(myComponent)     // components fire when the queue is empty
sim.At(0, "start", func(ctx *desim.Context) {
    delay := desim.Time(1 + ctx.Rand().Intn(5))
    ctx.Schedule(delay, "next", nextHandler) // derive a successor
})
res := sim.Run(desim.Budget{MaxSteps: 1000})
if !res.Completed {
    fmt.Println("remaining work:", res.Backlog)
}
snap := sim.Snapshot()            // includes RNG state
restored := desim.Restore(snap, freshComponents)
```

Handlers should resolve components via `ctx.Component(name)` rather than
capturing component pointers, so that restored snapshots stay consistent.
Components restore their dynamic state via `RestoreState`; construction-time
configuration is supplied by the caller.

## Tests

`go test ./...` — see TEST_RESULTS.txt for the recorded run.
