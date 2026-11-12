# Compact enumeration-coded bit index

`dataeng` is a Go-importable package for sparse and dense regions of a logical
0/1 sequence.  It stores a compressed payload plus a checkpoint directory; it
does not keep the original expanded column as a query shortcut.

## Wire format

The byte snapshot begins with a fixed 13-byte header:

| Offset | Width | Field |
| --- | --- | --- |
| 0 | u8 | block width `b`, 1..63 |
| 1 | u32 LE | checkpoint interval `S`, 1..4096 |
| 5 | u64 LE | logical length `N`, 0..2^32-1 |

The remaining bytes are an MSB-first bit stream.  A non-final block has
`m = b`; the final block has `m = N mod b` (or `b` when the division is exact).
For each block the encoder writes:

1. `c`, the number of one bits, using `ceil(log2(b+1))` bits;
2. `ordinal`, using `w = ceil(log2(C(m,c)))` bits.

`C` is the exact binomial coefficient.  `w` is found exactly with
`bits.Len64(C-1)` (zero when `C == 1`), never with a floating-point logarithm.
The ordinal is the rank of the `m`-bit block word among all same-weight words
in ordinary binary-value order, with the first logical bit as the most
significant bit.  It is not a colex combinadic rank.  Only low padding bits in
the final byte are zero.

## API

```go
encoded, err := dataeng.Encode(logicalBits, 32, 64)
index, err := dataeng.Open(encoded)              // copies and fully validates
bit, err := index.Access(1234)
ones, err := index.Rank1(2000)                   // ones in [0,2000)
zeros, err := index.Rank0(2000)
pos, found, err := index.Select1(17)             // zero-based k-th one
pos, found, err = index.Select0(17)
```

`Encode` accepts `[]byte` whose elements are exactly 0 or 1.  `N = 0` produces
a header-only snapshot.

`Open` rejects malformed headers, `c > m`, `ordinal >= C`, truncated class
fields, non-zero padding and trailing bytes.  Validation completes before an
`Index` is published.

Queries also have `...WithStats` variants.  A `QueryStats` reports:

- `BlockHeadersRead`: class fields actually read;
- `BlocksDecoded`: blocks actually reconstructed from their ordinal;
- `CacheHits`: decoded-block cache hits;
- `PayloadBitRanges`: half-open compressed payload bit ranges actually read.

`CheckpointAt(i)` exposes the read-only checkpoint metadata (block index,
logical start, payload bit offset and ones before), which makes the physical
layout and every-`S`-blocks spacing directly inspectable.

`Access` and rank queries start at the target block's checkpoint, inspect at
most `S` block headers and decode at most the target block.  Select binary-
searches the checkpoint directory using the relevant cumulative one/zero
counts, then scans at most `S` blocks and decodes only the hit block.  Taking
the rightmost checkpoint with a cumulative count `<= k` keeps all-zero and
all-one checkpoint plateaus in the searched region.  The index keeps at most
one decoded block; a cache hit reports zero decodes.

## Example

`examples/columnscan` shows a column-scan host iterating predicate matches
with `Select1WithStats` and using `Rank1`/`Access` for row-boundary work:

```sh
go run ./examples/columnscan
```

## Tests

Tests compare every `Access`, `Rank1`, `Rank0`, `Select0` and `Select1` result
against a separate bit-by-bit sequence reference for all short vectors.  They
also independently enumerate all same-weight words through `m = 12` to verify
the ordinal definition, and cover `b = 1`/`63`, `S = 1`, short final blocks,
`C-1` and invalid ordinals, checkpoint rank plateaus, long all-zero/all-one
regions, `N = 0`, truncation near zero-width blocks, tampered padding and query
access bounds.
