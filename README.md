# objstore

Content-addressed object store in pure Go standard library, with tree
references, temporary uploads, version roots, and a crash-safe
concurrent mark-sweep garbage collector.

## Features

- **Tree references** — every object stores outgoing references to other
  objects; reachability is computed transitively from the roots.
- **Temporary uploads** — `BeginUpload`/`Commit` and plain `Put` objects
  are protected by a lease (`Options.MinAge`) so callers have a grace
  period to anchor them before GC can reclaim them.
- **Version roots** — named roots (`SetRoot`/`DeleteRoot`) pin object
  trees; every mutation bumps a root generation recorded in the journal.
- **Concurrent-safe GC** — while a `Collect` cycle runs, `Put` and
  `SetRoot` act as write barriers: anything they make reachable is
  marked, so the sweeper never deletes a reachable object. The final
  file removal re-checks the mark under the cycle lock.
- **Deletion evidence** — every deletion is journaled *before* the file
  is removed and carries an `Evidence` record (cycle ID, object, root
  generation, root snapshot, marked-set size, reason, timestamp).
- **Crash recovery** — all mutations go through an fsynced write-ahead
  journal. On `Open`, deletions from an incomplete GC cycle are
  replayed (skipping anything reachable from recovered roots or still
  lease-protected), and the journal is compacted.
- **Injectable phase barriers** — `Hooks{AfterRootSnapshot, AfterMark,
  BeforeDelete}` let tests interleave mutations deterministically with
  collector phases (used to verify scan-time references, root
  replacement, and mid-sweep crash recovery).

## Layout

- `store.go` — store, objects, roots, uploads, journal replay
- `gc.go` — mark-sweep cycle, write barrier, evidence
- `journal.go` — append-only WAL with compaction
- `store_test.go`, `gc_test.go` — unit, concurrency, and recovery tests

## Test results

`go test ./...` (Go 1.27.1, linux/amd64):

```
ok  	objstore	0.377s
```

All 8 tests pass, including `go test -race -count=2 ./...`
(`ok objstore 3.438s`):

- TestPutGetAndTreeRefs
- TestUnreachableCollectedWithEvidence
- TestTempUploadLeaseProtectsYoungObjects
- TestDeleteRootReleasesTree
- TestConcurrentRootAdditionDuringGC
- TestRootReplacementDuringScan
- TestCrashMidSweepRecovery
- TestConcurrentPutAndRootStress
