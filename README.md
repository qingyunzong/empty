# crashreplay

A CLI that replays traces of **write**, **sync**, and **crash** events against
a crash-prone key-value store and verifies recovery invariants.

## Model

- `write k v` updates the in-memory view and appends to the unsynced log.
- `sync` flushes all unsynced writes to disk.
- `crash` simulates power loss: unsynced writes may be dropped **arbitrarily**.
  The store implementation publishes them to disk in a deliberately scrambled
  order and drops an arbitrary subset, modelling a real disk's volatile write
  cache.
- `recover` ends the crash episode; recovery starts from the persisted state.

The checker enumerates every persistent subset of the unsynced writes
(applied in program order) at each crash — subsets of up to **18** writes,
i.e. at most 2^18 = 262144 recoveries. Enumerating subsets in program order
also covers out-of-order publishes: any reordered application of a subset
equals the program-order application of some subset.

## Verdicts

- `OK` — every expectation holds in every enumerated recovery (exit 0).
- `COUNTEREXAMPLE` — the first violating recovery is reported: the persisted
  and dropped writes, the recovered state, and the **actual recovery**
  produced by the out-of-order publish implementation (exit 1).
- `UNKNOWN` — a crash had more than 18 unsynced writes, exceeding the
  enumeration budget; the actual recovery is still reported (exit 2).

## Trace format

```
write <key> <value>
sync
crash
expect eq <key> <value>     # also: neq, has, absent
recover
```

`expect` lines between `crash` and `recover` are the recovery invariants.
A trailing crash without `recover` is verified at end of trace.

## Usage

```
go run ./cmd/crashreplay verify [-seed N] <trace-file>
go test ./...
```
