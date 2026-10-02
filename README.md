# card-ledger

Card transaction ledger + CLI. Node.js 22, standard library only.

## State machine

```
auth --capture--> captured --refund-----> refunded --reverse--> captured (at most once)
auth --void-----> voided   --chargeback--> charged_back --reverse_chargeback--> captured
voided (terminal, immutable)
```

- Illegal transitions raise `E_TRANSITION`; terminal states reject everything.
- `reverse_chargeback` requires the original capture to be unlocked: a
  `settle` event locks all of the merchant's captures with
  `captureDay <= settleDay` (inclusive boundary, per merchant) → `E_LOCKED`.
- amount / currency / tip may be NULL. NULL amounts/tips are ignored by
  min/max/sum/tipSum aggregates; NULL currency falls into the `UNKNOWN` bucket.
- Unknown currencies (not in `KNOWN_RATES`: USD/EUR/GBP/CNY) are never
  converted; each gets its own bucket. Known currencies also feed the
  USD-converted total.

## Events (JSONL, one per line)

```json
{"type":"auth","id":"t1","merchant":"m1","day":"2026-10-01","amount":100,"currency":"USD","tip":10}
{"type":"capture","id":"t1","day":"2026-10-01"}   // day optional, defaults to auth day
{"type":"void","id":"t1"}
{"type":"refund","id":"t1"}
{"type":"reverse","id":"t1"}                      // undo a refund, once
{"type":"chargeback","id":"t1"}
{"type":"reverse_chargeback","id":"t1"}           // blocked by settlement lock
{"type":"settle","merchant":"m1","day":"2026-10-01"}
```

## API

- `ledger.apply(event)` — validate + apply, append to log.
- `ledger.merchantStats(merchant, day)` — materialized, incrementally maintained.
- `ledger.bruteForceStats(merchant, day)` — reference rescan of the log.
- `ledger.recomputeDay(merchant, day)` — rebuild one bucket from the log.
- `ledger.rollbackTo(day)` — drop events after `day` (and causal dependents), rebuild.

## CLI

```
card apply events.jsonl --stats <merchant> <day>
```

Success: JSON `{applied, stats?}` on stdout, exit 0.
Failure: `{"code","message"}` on stderr, exit 1.
Codes: `E_TRANSITION`, `E_LOCKED`, `E_NOT_FOUND`, `E_VALIDATION`, `E_PARSE`, `E_USAGE`.

## Tests

```
node --test
```

See RESULTS.md.
