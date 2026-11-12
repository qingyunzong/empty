# mergejoin

Importable Go merge-join package for two paginated, key-sorted input
streams. The module path is `example.org/dataeng/q0146`, import the package
as `example.org/dataeng/q0146/mergejoin`.

## Contract

- Each `Stream[P]` serves pages ordered by non-decreasing int64 `Row.Key`,
  both across pages and inside a page; a key may repeat.
- Rows carry a globally unique `uint64` ID and a caller-defined payload.
- For every key present on both sides, the join emits its full Cartesian
  product in left-row order and then right-row order (`Pair.Left.ID`,
  `Pair.Right.ID`). Keys missing on either side emit nothing.
- A key group larger than the configured memory budget is spilled through
  the caller-injected, replayable `Staging[L,R]` and processed in chunks.
  Replays that cannot reproduce the full product fail with
  `ErrTruncated`; rows are never silently dropped.
- The emit callback acknowledges a pair by returning a nil error, for both
  `Proceed` and `Pause`. `Pause` means the pair was received and the joiner
  blocks before the next pair until `Gate.Resume`; acknowledged pairs are
  never re-sent.
- Cancelling the run context aborts processing and closes both input
  streams and the staging handle.

## Minimal use

```go
left  := mergejoin.NewSliceStream(leftRows, 64)   // any Stream[L]
right := mergejoin.NewSliceStream(rightRows, 64) // any Stream[R]

cfg := mergejoin.Config[L, R]{
    MaxGroupRows: 10_000,                       // per key, per side
    MaxGroupBytes: 64 << 20,                    // optional, needs sizers
    LeftSizer: func(mergejoin.Row[L]) int { ... },
    RightSizer: func(mergejoin.Row[R]) int { ... },
}

joiner, err := mergejoin.New(left, right, cfg, emit,
    func() (mergejoin.Staging[L, R], error) {
        return mergejoin.NewMemStaging[L, R](), nil // or disk/object store
    })
if err != nil { /* ... */ }

// Optional external flow control.
joiner.WithGate(gate)
result, err := joiner.Run(ctx)
```

## Implementing a custom Staging

Provide a `Staging[L,R]` factory to `New`. Each spilled key gets one writer
per side; readers must support `Rewind` for repeated full replays (the
nested loop rewinds the right group for every left row) and `Discard` once
the group is fully emitted. `Close` is invoked exactly once when the run
ends, including on cancellation or error.

## Tests

`go test ./... -race` covers, against a full in-memory reference join:

- repeated groups, one-sided-only keys and empty sides;
- one-row pages and one-row/byte budgets that force staging replay;
- pause positions at the first, middle and final pair with no re-send;
- cancellation closing both streams and staging;
- truncation detection, unsorted input, emit errors and gate lifecycle.
