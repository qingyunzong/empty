# idx64 — 64-bit binary segment index library

C++20 library and CLI for parsing and validating a binary index of
64-bit `(offset, length)` segments. Standard library only, no
third-party dependencies.

## On-disk format (little-endian)

| Bytes      | Contents                                  |
|------------|-------------------------------------------|
| `[0, 8)`   | magic `IDX64V1\0`                         |
| `[8, 16)`  | `uint64 count`                            |
| `[16, ...)`| `count` records of `{uint64 offset, uint64 length}` |

## Validation semantics

- **Overflow-safe boundaries**: `offset + length` and
  `count * 16 + 16` are computed with checked arithmetic
  (`idx64::checked_end`); anything past 2^64 is rejected, never wrapped.
- **Sharing vs. overlap**: segments are half-open intervals
  `[offset, offset+length)`. Identical segments may be shared; any
  other intersection (including nesting) is a *partial overlap* and is
  rejected. Zero-length segments occupy no bytes and never overlap.
- **Read-only views stay in file**: every segment must satisfy
  `offset + length <= file size`. `Index::segment_view` returns spans
  that are guaranteed in bounds, and refuses files smaller than the
  validated size.

Error codes (`idx64::Error`): `BadMagic`, `TruncatedHeader`,
`TableSizeOverflow`, `TruncatedTable`, `OffsetOverflow`,
`SegmentOutOfFile`, `PartialOverlap`.

## Tools

- `idxcheck [--list] <file>` — validates an index file.
  Exit codes: `0` valid, `1` invalid index, `2` usage/IO error.
- `idxgen <case> <output>` — generates test files, including
  extreme-value cases (`overflow-end`, `max-end-beyond-file`,
  `huge-count`) and truncated data (`truncated-header`,
  `truncated-table`).

## Build and test

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build --output-on-failure
```

Tests (see `TESTING.md` for recorded results):

- `unit` — boundary arithmetic, extremes, truncation, sharing/overlap,
  view bounds.
- `crosscheck` — differential test against an independent
  arbitrary-precision (`BigUint`, standard library only) interval
  checker (`tests/reference.hpp`) on deterministic pseudo-random inputs
  biased toward `UINT64_MAX` extremes, truncations, and near-overlaps.
- `end_to_end` — CLI test: `idxgen`-generated extreme/truncated files
  classified by `idxcheck` with expected exit codes and messages.
