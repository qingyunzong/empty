# settle-core

Single-node, offline netting/settlement library and CLI. Node.js 22, standard
library only, tests via `node --test`.

## Layout

- `src/relalg.js` — relational algebra: `select` / `project` / `join` /
  `union` / `except` and aggregates `sum` / `count` / `avg`, with explicit
  SQL NULL three-valued semantics (NULL never compares true, `sum`/`avg`
  ignore NULLs, an all-NULL group sums to NULL — never 0).
- `src/engine.js` — netting by `(ccy, counterparty, trade_date)`. `Ledger`
  applies appended events (insert/cancel) incrementally, touching only the
  affected group; `settleFull` is an independent full recompute built on the
  relational algebra core.
- `src/cert.js` — verifiable certificate: canonical row order, sha256 chain
  over rows, seeded with the sha256 digests of the input files.
- `src/io.js` — JSONL input loading.
- `bin/settle.js` — CLI.

## Input

A directory with three JSONL files (missing/empty files count as empty):

- `accounts.jsonl`: `{"account_id": "A", ...}` — when non-empty, every trade
  counterparty must be a known account (`E_UNKNOWN_ACCOUNT`).
- `trades.jsonl`: `{"trade_id","ccy","counterparty","trade_date","amount","fee"}`
  — `fee` may be `null`; `trade_id`/`ccy`/`counterparty`/`trade_date`/`amount`
  must not be NULL (`E_BAD_NULL`). Duplicate `trade_id` → `E_DUP_TRADE`.
- `events.jsonl`: corrections —
  `{"type":"insert","trade":{...}}` or `{"type":"cancel","trade_id":"t1"}`.
  Cancels are idempotent: a duplicate reversal is a no-op.

## CLI

```
settle --in <dir> --out out.json --cert cert.json
settle verify --in <dir> --out out.json --cert cert.json
```

All errors exit non-zero and print a single JSON line `{"code","message"}`
to stderr (`E_DUP_TRADE`, `E_BAD_NULL`, `E_BAD_JSON`, `E_BAD_EVENT`,
`E_UNKNOWN_ACCOUNT`, `E_CERT_MISMATCH`, `E_IO`, `E_USAGE`, ...).

## Tests

```
node --test
```
