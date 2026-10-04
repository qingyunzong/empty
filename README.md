# simreplay — deterministic replay simulator

A deterministic event-driven simulator (Go standard library only) that models
message **send / loss / duplication / node crash / heal** events. All randomness
comes from a single seeded splitmix64 RNG, so a run is fully determined by
`(seed, nodes, events)`.

## Guarantees

- **Snapshots** (`sim.Snapshot`) capture the complete resumable state: node
  liveness, the full pending (in-flight) message queue, RNG state, message-id
  counter, and event index. Binary encoding via `Snapshot.Marshal` /
  `sim.UnmarshalSnapshot`.
- **Jump-and-resume**: restoring a snapshot taken before any event `i` and
  continuing produces output byte-identical to the full replay's suffix from
  event `i`.
- **Minimal divergence**: `sim.Check` / `sim.FindDivergence` resume from every
  snapshot and report the first (minimal) event index whose continuation
  diverges, or `-1` when fully consistent.

## Usage

```sh
go run . -seed 1 -nodes 5 -events 1000
# consistent: seed=1 nodes=5 events=1000 — resuming from every snapshot
# matches the full replay byte-for-byte
```

## Test results

`go test ./...` (go1.27.1 linux/amd64), all passing:

```
?   	simreplay	[no test files]
ok  	simreplay/sim	0.130s
```

Covered: same-seed determinism, seed sensitivity, replay consistency across
multiple seeds, snapshot round-trip resume, pending-queue + RNG-state capture,
and checker correctness (reports the minimal of one or multiple injected
corruptions).
