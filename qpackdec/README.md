# qpackdec

`qpackdec` is the importable post-parse QPACK receiver used by the HTTP/3
collector. The host parses QPACK wire bytes (integers, Huffman strings) and
feeds this component structured events; the package implements dynamic-table
state, required-insert-count wrap-around, and cross-stream blocking.

Import path: `example.org/dataeng/q0272/qpackdec`

## Model

- `New(maxCapacity M, blockedLimit, staticTable)` builds a decoder. The dynamic
  table starts at capacity zero; the static table is indexed from zero.
- Dynamic entry size is `len(name)+len(value)+32`. Absolute indices start at
  zero and increase monotonically for the connection.
- `Insert` and `SetCapacity` evict oldest-first. An entry larger than the
  current capacity is a connection error. Capacity never exceeds `M`.
- `HeaderBlockReceived` freezes the block at the current insert count `I`:
  - `K = floor(M/32)`, `F = 2K`.
  - `E=0 -> R=0`; otherwise `K>0`, `E<=F`, and `R` is recovered with the
    full-range wrap rule, rejecting an unreachable wrapped value and `R=0`.
  - Base is `R+Delta` for sign 0 and `R-Delta-1` for sign 1; negative bases
    are rejected.
  - Relative field `i` maps to `Base-i-1`; post-base `i` maps to `Base+i`.
  - When dynamic fields exist, `max(abs)+1` must equal `R`; otherwise `R` must
    be zero.
- A block with `R>I` is stored. Its recovered `R` and base are frozen, so a
  later insert count never re-interprets `E`. Insertions release ready blocks
  in reception order.
- An evicted absolute reference is a terminal error even if a newer entry now
  occupies the same ring slot.
- `CancelStream` discards a waiting block and permanently reserves the id.
- Duplicate, delivered, or cancelled stream ids are rejected. The blocked limit
  counts streams currently waiting; breaching it is a connection error.
- Every field of a block must validate before the ordered `ResolvedField` list
  (with static/dynamic/literal provenance) is delivered.
- Any decode error stops the component: `Err()` retains the evidence and all
  later operations return the same error.

All counters use checked `int64` arithmetic, so no counter silently wraps.

## Tests

- `arithmetic_test.go`: independent `math/big` reference cross-checking the
  required-insert-count and base arithmetic across full-range wrap, plus
  overflow checks.
- `table_test.go`: insertion, absolute indices, eviction, shrink and zero
  capacity.
- `decoder_test.go`: cross-stream wait order, cancellation, blocked limit,
  evicted references, base signs and zero-capacity static blocks.
- `wrap_test.go` and `eviction_wait_test.go`: insert counts crossing `F`,
  frozen blocks, and references evicted while a block waits.
- `replay_test.go`: scripted event replay with determinism assertions and the
  terminal-stop guarantee.

Run with `go test ./...` from the module root.
