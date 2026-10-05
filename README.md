# debugtrace

A record/replay debugging library in pure Go (standard library only).

## Design

- **Append-only trace** (`trace.go`): two block kinds — `KindInput`
  (recorded external input) and `KindSnapshot` (immutable state block).
  Payloads are copied on append and on read, so blocks are immutable once
  recorded.
- **Integrity chain**: every block stores a CRC-32 of its payload plus a
  SHA-1 hash chained to the previous block. `Verify` walks the chain and
  returns a `*CorruptionError` with the exact sequence number of the first
  damaged block. Damaged payloads, checksums, sequence numbers, and hash
  links are all detected.
- **Time-travel jumps** (`replay.go`): `StateAt(t, n, m)` restores the
  nearest snapshot at or before `n` and replays only the inputs after it.
  All blocks in the jumped prefix are verified first; on corruption the
  machine is reset and a `*CorruptionError` is returned — never a guessed
  state.
- **Branches**: `Trace.Branch()` forks the trace for exploratory
  debugging. The branch shares the immutable prefix but appends
  independently; neither side can modify the other's history.

## Test results

`go test ./...` (go1.27.1 linux/amd64, also clean under `-race`):

```
ok  	debugtrace	0.093s
```

8 tests pass, including:

- `TestRandomJumpsMatchFullReplay` — 300 random jumps, each compared
  byte-for-byte against a from-start replay.
- `TestBranchDoesNotModifyOriginal` — branch appends leave the original
  trace byte-identical and verifiable; random branch jumps match
  from-start replay byte-for-byte.
- `TestCorruptionIsLocatedNotGuessed` (+ checksum/sequence variants) —
  corruption is located by sequence number and jumps past it fail instead
  of returning guessed state.
