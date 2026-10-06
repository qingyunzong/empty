# blkarc

Append-only archive with independent block compression and a checksummed
offset table for random range reads.

## Format

```
[block 0][block 1]...[block N][index][footer]   <- generation 1
[block N+1]...[block M][index][footer]           <- generation 2 (append)
```

- Each block is flate-compressed independently; the index (offset table)
  records `{offset, compLen, rawLen, crc32}` per block plus the running
  SHA-256 state of all plaintext, and is itself CRC32-protected.
- The footer is a fixed 16-byte trailer `[indexLen uint64 LE]["GBLKEND1"]`
  pointing back at the last index.

## Guarantees

- **Random range reads**: `Reader.ReadAt` fetches and verifies only blocks
  intersecting the requested range.
- **Scoped corruption**: a damaged block fails intersecting reads with
  `*BlockError`; disjoint ranges keep working.
- **Index corruption rejects all**: a damaged index or footer fails `Open`
  (and `Append`) with `ErrIndexCorrupt`.
- **Snapshot/append isolation**: `Writer.Close` returns the index offset;
  `OpenSnapshot` at that offset reads exactly that generation, unaffected by
  later appends, and appends never touch committed bytes.
- **Whole-file hash**: `Reader.Verify` re-hashes the full plaintext against
  the SHA-256 recorded in the index.

## Usage

```go
f, _ := os.Create("a.blk")
w, _ := blkarc.Create(f, blkarc.DefaultBlockSize)
w.Write(data)
snap, _ := w.Close()          // snap = index offset of generation 1

w2, _ := blkarc.Append(f)     // append generation 2
w2.Write(more)
w2.Close()

r, _ := blkarc.Open(f)                 // latest generation
s, _ := blkarc.OpenSnapshot(f, snap)   // generation 1 only
buf := make([]byte, 100)
r.ReadAt(buf, 4096)
```

## Test

```
go test ./...
```

Covers random-slice round trips, per-block corruption scoping, index/footer
corruption rejection, snapshot/append isolation, byte-by-byte truncation at
every file prefix, and empty/single-block edge cases.
