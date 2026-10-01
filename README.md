# rchunk

Content-defined chunking (CDC) with a verifiable `.chunk` index.
Pure Python 3.11 standard library; tests use `unittest`.

## Chunking algorithm

- **Window** `W = 48` bytes, rolling weak checksum: 31-bit polynomial
  rolling sum, `h = (h * 257 + byte) mod 2**31`; sliding removes the
  outgoing byte's contribution `out * 257**47 (mod 2**31)`.
- **Fingerprint cut**: when the low 13 bits of `h` are all 1s
  (`h & 0x1FFF == 0x1FFF`) and the current chunk length is `>= 64`.
- **Forced cut**: at chunk length `4096`, even without a fingerprint
  match. If both conditions coincide on the same byte, the forced cut
  (reached first, by length) is taken; the boundary is identical either
  way.
- **EOF cut**: any remaining bytes form the final chunk.
- Rolling state resets at every boundary.

Determinism: the split of a byte stream is unique and independent of
read buffer size — `Chunker.feed()` may be called with any buffer sizes.

## Index format (`.chunk`)

Text format: header line `RCHUNK1`, then one line per chunk:

```
RCHUNK1
<offset> <length> <sha256-hex>
...
```

Entries are sorted by ascending offset and must tile the data
contiguously from 0 — any gap or overlap is `Corrupt`. `verify`
re-checks every chunk's sha256 and reports the smallest offset of the
first bad chunk.

## CLI

```
python -m rchunk chunk  INPUT [-o OUTPUT] [--buffer-size N]
python -m rchunk verify DATA INDEX
python -m rchunk locate INDEX POSITION
```

- `chunk`: writes `<INPUT>.chunk` (or `-o` path) with offset/len/sha256
  per chunk.
- `verify`: exit 0 and `OK: ...` when data matches the index; exit 1
  with `CORRUPT (offset N): ...` on stderr otherwise.
- `locate`: prints the (smallest) chunk covering byte `POSITION`.

## Tests

```
python -m unittest discover -s tests -v
```

See `RESULTS.md` for the recorded run.
