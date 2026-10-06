# objstore

Content-addressed object store in pure Go standard library.

## Features

- **Objects**: blobs and trees; trees reference children by content hash
  (SHA-256). `PutTree` validates that all referenced objects exist.
- **Version roots**: named pointers (`AddRoot`/`RemoveRoot`) persisted
  atomically (tmp + fsync + rename + dir fsync) in `state.json`.
- **Temporary uploads**: leases (`AddLease`/`ReleaseLease`) with TTL keep
  unrooted uploads alive until committed or expired.
- **Garbage collection** (`RunGC`): mark-sweep that never deletes objects
  reachable from roots or live leases — even when roots are added
  concurrently mid-cycle.

## GC concurrency safety

- `gcMu` serializes object-existence validation (in `AddRoot`, `AddLease`,
  `Put*`) against sweep deletion. Lock order: `gcMu` → `mu`.
- A root/lease/upload admitted during a GC cycle records its full closure in
  the cycle's protected set; the sweep checks it under `gcMu` before every
  delete. Additionally, candidates are rechecked against the current roots
  immediately before the sweep.
- Every deletion is preceded by an fsynced `Evidence` record in
  `evidence.log` (epoch, snapshot roots, recheck roots, reachable-set size)
  — no object is ever removed without unreachable evidence.

## Phase barriers

`Barriers` hooks (`AfterSnapshot`, `AfterMark`, `BeforeSweep`,
`BeforeDelete`) run synchronously inside a GC cycle so tests can
deterministically interleave root additions, root replacement, and crashes
with the collector.

## Crash recovery

`Open` removes stale `*.tmp` files and loads the last committed state.
Crashes are simulated in tests via `crashHook` (state persist) and barrier
panics (mid-sweep); see `TEST_RESULTS.md` for actual `go test ./...` output.
