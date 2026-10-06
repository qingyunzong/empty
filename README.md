# colcli — columnar integer CLI

A C++20 command-line tool that filters and aggregates integers **directly on
run-length-encoded (RLE) and bit-packed blocks**, without fully decoding the
column.

## Semantics

- `agg`: `sum` skips nulls; `rows` counts **all** rows (nulls included);
  `non_null` counts rows participating in the sum. Sum is exact (`__int128`).
- `filter`: prints 0-based positions of matching rows; positions correspond to
  original row numbers. Nulls never match any comparison.
- Blocks are scanned in place: RLE runs are compared/summed once per run
  (`value * len`), bit-packed values are extracted slot-by-slot from packed
  words — no decoded column array is ever materialized.
- All-or-nothing: every block header, payload shape, and FNV-1a checksum is
  validated **before** any query work; a corrupt block aborts the query with a
  non-zero exit and no partial results are published.

## Usage

```sh
colcli build <input.txt> <output.col> [block_rows]   # encode text ("null" or int per line)
colcli agg <file.col>                                # rows=<N> non_null=<M> sum=<S>
colcli filter <file.col> <eq|ne|lt|le|gt|ge> <value> # matching row positions, one per line
```

## File format

```
file   := magic("COL1") u64 total_rows u32 num_blocks block*
block  := u8 enc u64 row_count u32 payload_size u32 checksum payload
enc=1 (RLE)      payload := u32 num_runs (u8 is_null i64 value u64 len)*
enc=2 (bitpack)  payload := i64 offset u8 width bitmap[ceil(n/8)] packed[ceil(n*w/8)]
```

Bit-packed slots store `value - offset` as unsigned `width`-bit integers,
little-endian bit order; null slots are marked in the bitmap and store 0.
`checksum` is FNV-1a-32 over the payload. All integers are little-endian.

## Build & test

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
cd build && ctest --output-on-failure
```

Tests (`coltest` + CLI end-to-end via CTest):

- `unit_random` — randomized columns (mixed nulls, runs, full int64 range,
  random block sizes, forced/auto encodings) cross-checked against a naive
  row-by-row reference for all six comparison operators and aggregation.
- `unit_edge` — empty/all-null/single-row columns, int64 min/max (64-bit
  packing, `__int128` sum overflow), null exclusion from sum.
- `unit_corrupt` — every single-byte flip, every truncation length, and
  trailing garbage must be rejected.
- `cli_*` — build/agg/filter on a checked-in fixture plus error paths.
