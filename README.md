# midx — Merkle index for files

Computes sha256 over fixed-size blocks of a file and stores a complete
binary Merkle tree in `FILE.index`.

## Index format (big-endian)

```
"MIDX"   4 bytes magic
u32      block size (bytes, need not be a power of two)
u64      data file size
u32      leaf count
level 0  leaf hashes (leaf_count * 32) + u32 crc32
level 1  hashes + u32 crc32
...      every level except the root carries a crc32 of its hash bytes
root     exactly 32 bytes, no crc32
```

Tree rules: complete binary tree built bottom-up; an odd tail node is
duplicated and paired with itself; the tail block of the file is hashed
with its actual (short) length. Any corruption of the index (bad magic,
crc32 mismatch, truncation, trailing bytes, inconsistent tree) raises
builtin `IndexError`.

## CLI

```
python -m midx build  FILE [--block-size N] [--index PATH]
python -m midx verify FILE [--index PATH] [--offset O] [--length L]
python -m midx root   FILE [--index PATH]
```

`verify --offset --length` reads only the blocks covering the byte range
(plus the index) — it never scans the whole file. The first bad block is
reported in ascending offset order (smallest block number wins).

Exit codes: `0` ok, `1` bad data found, `2` usage/IO error, `4` index
corrupt (`IndexError`).

## Tests

```
python -m unittest discover -s tests -v
```
