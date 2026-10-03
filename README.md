# fee-settlement

Deterministic fee settlement engine (Node.js 22, standard library only). Syncs
rule versions and transaction streams into a durable, checkpointed state, and
replays any historical interval to identical fees.

## Data formats

`rules.ndjson` — one op per line:

```json
{"op":"add","ruleId":"std-2026","validFrom":1700086400000,"validTo":null,"rateBps":150,"priority":0}
{"op":"revoke","ruleId":"promo-b","at":1700050000000}
```

- Times are epoch ms or ISO-8601 strings; windows are `[validFrom, validTo)`.
- `rateBps` is the fee rate in basis points; amounts are integer minor units;
  `fee = floor(amount * rateBps / 10000)`.
- `revoke` closes a rule going forward but never deletes history.
- Rule event times (`validFrom` / `at`) must be non-decreasing across the stream.

`tx.ndjson` — one transaction per line: `{"txId","time","amount"}`. A late
arrival into an already-settled range must carry `"backfill": true`; reusing an
existing `txId` with `backfill` triggers an incremental correction (last write
wins), never a full recompute.

## Commands

```sh
node cli.js sync   --rules rules.ndjson --tx tx.ndjson --state DIR
node cli.js fee    --state DIR (--txId ID | --time T --amount N)
node cli.js verify --state DIR [--from T] [--to T]
```

- `sync` consumes new lines since the checkpoint, appends fee records to
  `DIR/settled.ndjson` (fsync), then atomically writes `DIR/checkpoint.json`.
  A crash in between is safe: replayed lines that reproduce the journaled
  record exactly are skipped, so backfills are neither lost nor duplicated.
- `fee` explains one charge: all candidate rules, every rule tied for the best
  rate, the fixed tie-break (priority desc, ruleId asc), and the final fee.
- `verify` recomputes the interval `[from, to)` from the source files and
  compares its SHA-256 summary against the incrementally maintained journal.

## Errors

- `code=40` — overlapping rules tie for the best rate without declared priority.
- `code=41` — stream time goes backwards (unmarked late tx, duplicate txId, or
  rule event time regression).

## Tests

```sh
node --test test/*.test.js
```
