# Bitemporal Equipment-State Audit

Offline, single-machine audit of equipment state history. Node.js 22, standard
library only; tests use `node:test`.

## Model

- Events are `{id, equipment, valid_time, state, tx_id, tx_time}` with
  `state in {up, down}`. Timestamps are ISO-8601 (date-only, or date-time with
  an explicit zone).
- The log is **append-only**: a correction is a new event with the same
  `(equipment, valid_time)` and a later `tx_time`; old records are never
  overwritten.
- **Bitemporal queries**: `asof <equipment> <valid_time> [tx_time]` filters by
  `tx_time`, so a view taken at an old transaction time is immutable under
  later retroactive corrections; omitting `tx_time` gives the current view
  (all corrections applied). Visibility follows `tx_time`, never arrival
  order.
- **Daily up/down counts** per equipment are maintained incrementally; every
  commit/undo prints the positive/negative deltas of the affected dates.
- **Undo** by `tx_id` appends an undo record and maintains both the snapshot
  and the emitted deltas.
- **Atomic batches**: any schema or time violation rejects the whole batch
  before anything is written — no partial state, counts and hash unchanged.
- **Crash recovery**: commit order is validate → append `events.log` (fsync) →
  apply → persist `state.json` (tmp+rename+fsync). A crash after the append is
  healed by replaying the log tail on the next open; a crash before the append
  has no effect.
- **Reference algorithm** (`src/reference.js`) independently rescans all
  records and rebuilds the bitemporal intervals from scratch; `verify`
  compares it against the incremental engine, and randomized tests
  cross-check both on every operation.

## Usage

```sh
node cli.js [--data DIR] append <batch.json|->   # commit an atomic batch
node cli.js [--data DIR] undo <tx_id>            # undo a transaction
node cli.js [--data DIR] asof <eq> <valid_time> [tx_time]
node cli.js [--data DIR] counts [equipment]
node cli.js [--data DIR] hash
node cli.js [--data DIR] verify
```

A batch is either an array of events (uniform `tx_id`/`tx_time`) or an
envelope `{tx_id, tx_time, events:[...]}`; see `examples/`.

## Tests and scenarios

```sh
node --test                 # full test suite
npm run scenarios           # regenerate result.txt from real CLI runs
```

`result.txt` captures the genuine output of the three acceptance scenarios:
retroactive correction, out-of-order `tx_time`, and atomic rejection of an
invalid batch.
