# Tail-sampling trace collector

`Collector` is a Go decision component for a distributed tracing sampling
pipeline. It merges out-of-order span fragments by trace, evaluates error,
latency, and business-attribute rules, and makes exactly one tail-sampling
decision per trace when the collection window closes.

## Semantics

- A trace deadline is `earliest span start + Config.Timeout`.
- At the deadline, rules are evaluated in ascending `Priority` order. Equal
  priorities are ordered by rule ID. The first matching rule wins; otherwise
  `Config.DefaultVerdict` applies.
- A trace produces exactly one `Decision`. Repeated `Collect` calls do not
  return it again.
- For `Config.MaxLateness` after the deadline, late fragments may supplement a
  retained trace. They are ignored for a dropped trace and cannot revive it.
- After the lateness window the trace state is reclaimed. Later fragments are
  rejected as expired and never create a new trace.
- The no-revival guarantee assumes the normal tracing invariant that one trace
  ID is never reused and every fragment reports the same trace start. A
  fragment outside the configured lateness window is rejected, not adopted.
- Duplicate fragment identities are merged idempotently, so span and error
  counts cannot be inflated by retries.
- Attribute conflicts are resolved by earliest span start, then span ID. The
  aggregate therefore does not depend on fragment arrival order.

## Usage

```go
clock := formal.NewManualClock(start)
collector, err := formal.NewCollectorWithClock(formal.Config{
    Timeout:       30 * time.Second,
    MaxLateness:   5 * time.Minute,
    DefaultVerdict: formal.Drop,
    Rules: []formal.Rule{
        {
            ID:       "errors",
            Priority: 10,
            Verdict:  formal.Keep,
            Match:    formal.Match{HasError: boolPtr(true)},
        },
        {
            ID:       "slow",
            Priority: 20,
            Verdict:  formal.Keep,
            Match:    formal.Match{MinDuration: time.Second},
        },
    },
}, clock)

_, _ = collector.Ingest(fragment)
decisions := collector.Advance(30 * time.Second)
```

Use `Stats` and `Snapshot` to observe pending traces, late supplements, and
memory reclamation. Run `go test -race ./...` for the deterministic virtual-time
test suite.

`Ingest` returns an `IngestResult` describing whether a fragment created,
merged into, supplemented, or was rejected by a trace. `Advance` moves a
`ManualClock` and drains newly finalized `Decision` values; with `RealClock`,
call `Collect` periodically from the sampling pipeline.
