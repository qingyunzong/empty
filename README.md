# fill-join

Event-time windowed join of securities fills (`trades.jsonl`) and cancels
(`cancels.jsonl`) for end-of-day settlement. Node.js 22 standard library only.

## Usage

```sh
node cli.js join --trades t.jsonl --cancels c.jsonl --out fills.jsonl
node --test
```

`fills.jsonl` gets one row per fill / late-join:
`{orderId, symbol, qty, win, proof}` (late-join rows add `"late": true`).
`proof` is the SHA-256 Merkle root over the contributing input line numbers
(`T<n>` = trades.jsonl line n, `C<n>` = cancels.jsonl line n; odd tree nodes
are promoted unchanged).

Stdout prints a JSON summary: per-symbol settleable qty/amount (integer
cents), orphan cancels, and per-stream watermarks (max event time seen).

## Semantics

- **Windows**: 10 s tumbling windows on event time, `win = floor(ts / 10000)`.
- **Watermarks**: each stream keeps its own watermark (max ts seen); both
  sides may arrive arbitrarily out of order — input is re-sorted into
  canonical `(ts, line)` order, so output is independent of file line order.
- **Join key**: `(orderId, symbol)`. A cancel matches open trade qty in its
  own or any earlier window (FIFO by trade ts), even when `cancel.ts <
  trade.ts` inside the same logical window.
- **Partial cancels**: a cancel may consume part of a trade (and span several
  trades of the same key); the remainder stays open to cancels in subsequent
  windows.
- **Same-window** cancels reduce the fill before it is published. **Later-window**
  cancels emit a `late-join` correction row (negative qty in the cancel's
  window) without modifying the already published window.
- **Dedup**: a repeated cancel (same orderId/symbol/qty/ts) takes effect once.
- **Orphans**: cancel qty with no open trade (unknown order, trade only in a
  later window, or insufficient remaining qty) is listed under `orphans` and
  never produces a negative fill. Orphans are a business condition, not an
  error.

## Input rows

- trade: `{orderId, symbol, qty, price, ts}` — `price` in integer cents
- cancel: `{orderId, symbol, qty, ts}`

## Exit codes

- `0` — success (orphans and late-joins do not fail the run)
- `2` — usage error, unreadable file, or row error: missing field, invalid
  JSON, `qty <= 0`, non-integer-cents price, invalid ts
