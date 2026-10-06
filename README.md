# segidx

A small Go search library built from **immutable index segments** merged by
document ID, with term positions, consecutive-position phrase queries,
versioned deletes, and snapshot isolation.

## Design

- **Immutable segments** — every `Add` commit builds one immutable `Segment`
  (term → postings of `(docNum, positions)`). Segments are never modified in
  place.
- **Versions** — every commit gets a monotonically increasing version. For
  each document ID the newest version wins, so re-indexing the same ID is an
  atomic replace.
- **Tombstones** — `Delete` records `(ID, version)`; it shadows every older
  version of that ID. Re-adding the ID afterwards works.
- **Snapshots** — commits atomically swap an immutable `indexState`
  (segments + tombstones). A `Snapshot` pins that state, so old snapshots keep
  seeing old documents regardless of later writes or compaction.
- **Compaction** — `Compact` merges all segments into one, physically dropping
  shadowed and deleted documents and all tombstones (deletes cannot resurrect
  because no older segment survives). `MergeOldest(n)` merges a prefix of the
  segment list and retains exactly the tombstones that could still shadow
  documents in the unmerged tail.
- **Phrases** — phrase queries use stored positions and require strictly
  consecutive positions (`p, p+1, …`), which also handles repeated terms.

## API

```go
ix := segidx.New()
ix.Add(segidx.Document{ID: "a", Text: "the quick brown fox"})
ix.Add(segidx.Document{ID: "a", Text: "the quick red fox"}) // atomic replace
ix.Delete("a")

snap := ix.Snapshot() // stable view, unaffected by later commits
ids := snap.Search(segidx.Phrase("quick", "brown", "fox"))
_ = segidx.And(segidx.Term("quick"), segidx.Not(segidx.Term("lazy")))

ix.Compact()        // merge everything, drop tombstones
ix.MergeOldest(3)   // partial merge of the 3 oldest segments
```

## Tests

`go test ./...` runs unit tests plus a randomized test that applies random
adds/updates/deletes/snapshots/compactions and compares random term, phrase,
and/or/not queries against a brute-force word-by-word scan of the original
document texts, verifying that deleted documents never reappear — including
after segment compaction.
