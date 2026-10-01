# rchunk

Content-defined chunking with a verifiable `.chunk` index.
Pure Python 3.11 standard library; tests use `unittest`.

## Algorithm

- Window `W = 48` bytes.
- Weak checksum: 31-bit polynomial rolling sum,
  `h = (h * 257 + byte) mod 2**31` over the last 48 bytes.
- Cut after a byte when chunk length `>= 64` and the low 13 bits of the
  hash are all ones (`h & 0x1FFF == 0x1FFF`), or at EOF.
- Hard limit: length `4096` forces a cut even without a hash hit; when
  both conditions coincide, the cut happens at that byte (whichever
  condition is reached first decides).
- Boundaries depend only on the byte stream, never on feed buffer sizes.

The `.chunk` index (JSON) stores `offset`, `len` and `sha256` per chunk,
plus the chunking parameters and total size.

## CLI

    python3.11 -m rchunk chunk  DATA INDEX     # write .chunk index
    python3.11 -m rchunk verify DATA INDEX     # rebuild mode; Corrupt -> exit 1
    python3.11 -m rchunk locate INDEX OFFSET   # print chunk covering OFFSET

`verify` enforces: offsets ascending and contiguous (any gap or overlap
is `Corrupt`), total coverage equals the data size, and every chunk hash
matches; the first bad chunk is reported with the smallest offset.

## Tests

    python3.11 -m unittest discover -s tests -v

See `RESULTS.md` for the recorded run.
