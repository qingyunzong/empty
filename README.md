# sparseix

Sparse-file segment index manager (Python 3.11+, standard library only).

A target file holds data written sparsely at arbitrary offsets; a sidecar
`<file>.idx` records the occupied byte ranges so readers can tell real data
from holes (holes read back as `0x00`).

## Index format (little-endian)

```
magic    4s    "SPIX"
version  u32   currently 1
count    u32   number of segment records
record   ...   count * (u64 start, u64 length, u32 crc32-of-data)
```

Records are strictly ascending by `start` and non-overlapping; any
violation (bad magic, zero length, overlap, truncation, crc mismatch on
`check`) raises `IndexCorrupt`.

## Semantics

- `write(off, data)`: overlapping or touching segments are merged with the
  new bytes (new bytes win) into a minimal segment list; `length == 0` is
  rejected.
- `read(off, n)`: bytes not covered by any segment return `0x00`.
- `check(file)`: validates index invariants and every segment's crc32.

## CLI

```
python3 -m sparseix write FILE OFFSET HEXDATA
python3 -m sparseix read  FILE OFFSET LENGTH   # prints hex
python3 -m sparseix check FILE
```

## Tests

```
python3 -m unittest discover -s tests -v
```
