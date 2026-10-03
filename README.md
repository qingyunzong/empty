# vd-settlement

Multi-currency settlement engine: trades are netted per currency pair, queued per
value date, and paired into settlement instructions. Built on a dependency graph
(`calendar -> trade -> pair-net/value-date queue -> settlement`) with differential
exposure maintenance, invalidation propagation across value dates, deterministic
UTC-only recomputation, and hash-chained journals for replayable proofs.
Node.js 22, standard library only.

## Test

```sh
node --test
```

## CLI

```sh
node bin/cli.js [--data DIR] [input.jsonl]   # reads stdin when no file is given
```

JSONL commands, one per line:

- `{"op":"calendar","version":"v2","holidays":["2026-01-05"]}` — register/switch holiday calendar version
- `{"op":"trade","id":"T1","payCcy":"EUR","payAmt":100,"recvCcy":"USD","recvAmt":110,"valueDate":"2026-01-05","maturity":"2026-01-05T10:00:00.000Z"}`
- `{"op":"cancel","id":"T1"}` — unlocks both sides of a pair, emits a `CANCEL_COMPENSATION` record
- `{"op":"delay","id":"T1","valueDate":"2026-01-06"}`
- `{"op":"reprice","id":"T1","rate":1.25}`
- `{"op":"liquidity","ccy":"EUR","amount":1000}`
- `{"op":"deliverables"}` / `{"op":"exposures"}` / `{"op":"queues"}` / `{"op":"proof"}`

Deliverables are ordered by value date, then maturity, then id. Trades short on
liquidity are reported as `PENDING` with reason `INSUFFICIENT_LIQUIDITY:<CCY>`
(never a failure); unmatched trades are `PENDING` with reason `UNMATCHED`.
Any command error is written to stderr and the process exits with code 7.

With `--data DIR`, the journal (`journal.jsonl`) and queue index (`index.json`,
written via tmp+rename) are persisted. On restart a torn or stale index is
detected via checksum/journal length and rebuilt from the journal
(`"indexRebuilt":true` in the `loaded` notice).
