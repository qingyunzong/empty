# Test results

Environment: GCC 15.2.0, CMake 4.2.3, `-std=c++20 -Wall -Wextra -Wpedantic`
(zero warnings), Release build. Date: 2026-10-06.

## CTest summary

```
1/3 Test #1: unit .............................   Passed    0.06 sec
2/3 Test #2: crosscheck .......................   Passed    1.55 sec
3/3 Test #3: end_to_end .......................   Passed    1.55 sec

100% tests passed, 0 tests failed out of 3
```

## unit

`all unit checks passed` — covers `checked_end` extremes
(`UINT64_MAX ± k`), header/table truncation, table-size overflow at
`count = (2^64-17)/16 + 1`, `offset+length` overflow vs. exactly-
`UINT64_MAX` ends, end == file-size boundary, sharing vs. partial
overlap vs. nesting, zero-length segments, and `segment_view` bounds.

## crosscheck (differential vs. arbitrary-precision reference)

```
crosscheck: 2000000 iterations, 205153 valid, all matched reference
```

2,000,000 deterministic pseudo-random files (extreme offsets/lengths
near `UINT64_MAX`, huge counts, truncations, byte corruption,
near-overlapping intervals): the production parser's accept/reject
decision and error category matched the `BigUint` reference checker on
every case, and every `segment_view` stayed within the file.

## end_to_end (CLI)

```
case valid:               exit 0, OK: 3 segment(s), file 128 bytes
case empty:               exit 0, OK: 0 segment(s), file 16 bytes
case shared:              exit 0, OK: 3 segment(s), file 88 bytes
case zero-len-inside:     exit 0, OK: 2 segment(s), file 80 bytes
case overlap:             exit 1, INVALID: segments partially overlap
case nested:              exit 1, INVALID: segments partially overlap
case overflow-end:        exit 1, INVALID: offset + length overflows 64 bits
case max-end-beyond-file: exit 1, INVALID: segment extends past end of file
case beyond-file:         exit 1, INVALID: segment extends past end of file
case huge-count:          exit 1, INVALID: record table size overflows 64 bits
case truncated-table:     exit 1, INVALID: record table truncated
case truncated-header:    exit 1, INVALID: truncated header
case bad-magic:           exit 1, INVALID: bad magic
```

Plus: `idxcheck` with no arguments and with a missing file exits `2`;
`idxcheck --list valid.idx` reports all 3 segment views `in-bounds`.

Reproduce: `cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j && ctest --test-dir build --output-on-failure`
