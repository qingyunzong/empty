# dualindex

A retrieval library (Go standard library only) that maintains a **content
index** (term → document paths) and a **path index** (path → metadata) over a
document set, and publishes both atomically as a single **generation**.

## Guarantees

- **Same-generation reads**: readers acquire a `Snapshot`; the content index,
  path index, and raw documents inside one snapshot always come from the same
  build. The two index files each record their generation number, and
  `Snapshot.ContentGen()` / `Snapshot.PathGen()` are verified against
  `Snapshot.Gen()` in tests.
- **Failed builds keep the old generation**: `Update` builds the new
  generation in a private directory and only then flips the `current`
  pointer (atomic rename). Any failure before or at publish leaves the
  previously published generation untouched and removes the half-built
  directory.
- **Deferred deletion**: a retired generation's files are deleted only after
  its last reader calls `Snapshot.Close()` (reference counting + GC at
  publish and at release).

## On-disk layout

```
<dir>/
  current                    # published generation number (atomic rename)
  generations/
    gen-000001/
      docs.gob               # raw document set of this generation
      content.gob            # content index (Gen + term -> paths)
      path.gob               # path index    (Gen + path -> PathEntry)
```

Each file is written via temp-file + fsync + atomic rename, followed by a
directory fsync.

## Fault injection

`Store.Faults.Fail(point, times)` arms failures at three points:

- `FaultPersistContent` — persisting the content index
- `FaultPersistPath` — persisting the path index
- `FaultPublish` — publishing the new generation

`Update` returns an error wrapping `ErrInjected`; the old generation stays
published. `times < 0` fails permanently, `times > 0` fails that many builds.

## Tests

```
go test ./...
```

- `TestQueryMatchesRawScan` — index queries vs. an independent re-scan of the
  raw files on disk (separate tokenizer implementation as ground truth).
- `TestFaultInjectionKeepsOldGeneration` — one subtest per fault point:
  old generation stays published and queryable, half-built directory is
  removed, next build recovers.
- `TestOldGenerationDeletedAfterReaderRelease` — pinned generation survives
  on disk while read, is collected on `Close`; unreferenced generations are
  collected at publish.
- `TestConcurrentReadersSeeConsistentGeneration` — concurrent readers verify
  generation consistency and query results against each snapshot's raw
  documents while a writer applies randomized batches with random injected
  faults.
- `TestReopenRecoversPublishedGeneration` — published state survives reopen;
  a failed publish leaves no visible state.
