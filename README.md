# quota-freeze-ledger

Deterministic quota freeze/confirm/cancel approval ledger (Node.js 22, standard
library only) plus a CLI that turns an event history into a replayable
certificate.

## Model

- Events: `{ requestId, idempotencyKey, ts, amount, action }` with
  `action in FREEZE | CONFIRM | CANCEL` and `ts` a logical timestamp.
- Any arrival order is canonicalized to a unique serial order:
  `(ts, requestId, action rank, idempotencyKey)`. Replaying the same history
  always yields the same accepted sequence and `stateHash`.
- Identical retries (same `idempotencyKey`) are deduped; reusing a key with a
  different payload is an `IDEMPOTENCY_CONFLICT` error.
- `FREEZE` reserves quota if available, else `REJECTED_INSUFFICIENT_QUOTA`.
  The pool never oversells.
- `CONFIRM` is valid only on an accepted freeze; otherwise it is rejected with
  an explicit status (`CONFIRM_WITHOUT_FREEZE`, `CONFLICT_ALREADY_CANCELLED`).
- `CANCEL` on a frozen request releases the reservation; on a confirmed
  request it emits a compensating release (`COMPENSATED`).

## Usage

```sh
node cli.js history.json            # { "quota": 10, "events": [...] }
node cli.js events.json --quota 10  # bare event array
```

Prints a certificate with `acceptedOrder`, `decisions`, `finalState` and
`stateHash`. On error it exits with code 1 and writes
`{"error":{"code","message"}}` to stderr.

## Tests

```sh
node --test
```
