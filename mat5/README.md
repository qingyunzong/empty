# mat5 — closed MAT-Level-5 subset parser

`mat5` parses the bytes that remain after a MAT-file header has been removed.
A fixed byte order is supplied per stream; no endian sniffing is performed.

## Supported subset

Normal elements are `uint32 type`, `uint32 payloadBytes`, payload, then padding
to an eight-byte multiple. Allowed normal types:

| type | meaning  |
| ---- | -------- |
| 1    | int8     |
| 5    | int32    |
| 6    | uint32   |
| 9    | float64  |
| 14   | matrix   |
| 15   | zlib     |

When the first `uint32` is not one of those values, it is decoded as a compact
small element: `uint16 type`, `uint16 n` with `1 <= n <= 4`, followed by `n`
data bytes inside the same fixed eight-byte element. Small elements never use
the normal payload-length jump.

Top-level elements are only matrix or zlib. A zlib element uses a normal header
but no trailing padding. Its inflated bytes must be exactly one normal matrix
element with no trailing bytes; nested zlib is rejected, the zlib checksum and
end-of-stream marker are verified, and every declared compressed byte must be
consumed (a concatenated second stream is rejected).

Matrix bodies contain, in order:

1. an eight-byte normal type-6 flags element; class is 1 (cell), 6 (double) or
   12 (int32), bit `0x800` marks complex doubles only, all other bits and the
   second flags word must be zero;
2. a type-5 dimension vector with at least two non-negative int32 dimensions;
3. a type-1 name (strict ASCII letter/underscore start, alphanumeric/underscore
   remainder at top level; empty for cell children);
4. class-specific data:
   - double: one type-9 real part, plus a type-9 imaginary part for complex,
     each exactly `8 * elementCount` bytes; raw 64-bit patterns are retained so
     NaN payloads and negative zero survive;
   - int32: one type-5 data element of exactly `4 * elementCount` bytes;
   - cell: exactly `elementCount` child matrix elements in column-major order.

A zero dimension makes the product zero immediately. Otherwise every multiply
is checked for overflow before any allocation.

## Budgets

`Limits` carries four host budgets, all required to be positive and checked
while parsing:

- `MaxInflatedBytes` — cumulative zlib output;
- `MaxMatrixNodes` — every matrix including cell children;
- `MaxNumericCells` — total double/int32 numeric units;
- `MaxDepth` — nesting depth, with a top-level matrix at depth 1.

Untrusted length fields never drive unbounded allocation: numeric storage is
reserved only after the product and budget checks succeed.

## Provenance

Each matrix carries a `Source`:

- `Physical` is the header+payload range inside the original input (padding
  excluded);
- for inflated content, `Inflated` is true and `Logical` is the range inside
  the inflated stream. The logical offset is never presented as a direct file
  offset.

## Access

- `Table.Lookup(name)` returns a typed value;
- `Table.Get(name, chainAndCoord...)` walks one linear column-major cell index
  per cell level, then a full numeric coordinate;
- concrete matrices expose `At(coord...)`, `RealBits`, `ImagBits` and `Values`.

A parse only publishes a table after the entire stream validates. Truncation,
extra sub-elements, class/type mismatches and over-limit inflation return
errors and never leave a half-published table.

## Test fixture

`mat5/mat5enc` is a standalone encoder that shares no parser internals. It
produces padded normal elements, compact small names, unpadded zlib elements
and nested cells. `cmd/mat5demo` wires the encoder and parser together for
both byte orders without MATLAB or an external matrix library.
