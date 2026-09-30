# sparseix

Sparse file region index manager (Python 3.11+, standard library only).

A target data file is written sparsely; a sidecar `<file>.idx` tracks the
written regions:

```
magic   4s   "SPIX"
version u32
count   u32
records count * (start u64, length u64, crc32 u32)   # ascending, non-overlapping
```

## Semantics

- `write(off, data)` merges overlapping or adjacent segments; new bytes
  override old ones and the segment set stays minimal. Zero-length writes
  raise `ValueError`.
- `read(off, n)` returns `0x00` for bytes not covered by any segment.
- Loading an index whose records are not strictly ascending, overlap, have
  zero length, or fail crc32 validation raises `IndexCorrupt`.

## CLI

```
python -m sparseix write <file> <offset> <data> [--hex]
python -m sparseix read  <file> <offset> <length> [--hex]
python -m sparseix check <file>
```

## Tests

```
python -m unittest discover -s tests -v
```
