# card-ledger

Card transaction ledger library + CLI. Node.js 22, standard library only.

## State machine

```
auth ──capture──▶ capture ──refund──────▶ refund ──reverse_refund──▶ capture
  │               │                                                (once per tx)
  │               ├──chargeback──▶ chargeback ──reverse_chargeback──▶ capture
  │               │                                   (only if not settlement-locked)
  └──void──▶ void (terminal, immutable)
```

- Illegal transitions throw `E_TRANSITION`; terminal states reject everything.
- A refund may be reversed at most once per transaction.
- `reverse_chargeback` requires the original capture to be unlocked.
  Lock boundary: a capture is locked iff its merchant has a settlement with
  `settleDay >= captureDay` (inclusive). Locked reversal fails with `E_LOCKED`
  and has no side effects.

## Events (JSONL, one object per line)

| type | fields | notes |
|---|---|---|
| `auth` | `id, merchant, day, amount?, currency?, tip?` | amount/currency/tip may be `null` |
| `capture` | `id, day, amount?, tip?` | optional amount/tip override auth values |
| `void` | `id` | auth → void |
| `refund` | `id` | capture → refund |
| `reverse_refund` | `id` | refund → capture, once |
| `chargeback` | `id` | capture → chargeback |
| `reverse_chargeback` | `id` | chargeback → capture, if not locked |
| `settle` | `merchant, day` | locks captures with `captureDay <= day` |

Days are `YYYY-MM-DD` strings. Amounts are minor units (numbers).

## Stats

`merchantStats(merchant, day)` aggregates capture events into per-currency
buckets `{count, min, max, sum}`, materialized and maintained incrementally
(`src/stats.js`). `effective = amount + (tip ?? 0)`; `null` amount skips the
record, `null` tip is ignored. Known currencies (USD/EUR/GBP/CNY/JPY) are
converted into `totalUsd`; unknown/`null` currencies are never converted and
stay in their own bucket (`null` currency → `UNKNOWN`).

`recomputeStats(merchant, fromDay)` drops materialized days `>= fromDay` and
rebuilds them from the append-only capture log (backtracking recompute).

## CLI

```
card apply events.jsonl [--stats <merchant> <day>]
```

Prints the stats (or `{"applied": n}`) as JSON on stdout. On error exits
non-zero and writes `{"code","message"}` JSON to stderr. Codes:
`E_TRANSITION, E_LOCKED, E_NOT_FOUND, E_DUPLICATE, E_VALIDATION, E_IO, E_USAGE`.

## Test

```
node --test
```
