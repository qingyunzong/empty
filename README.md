# quota-freeze-approval

Deterministic quota freeze/confirm/cancel approval engine (Node.js 22, standard
library only) plus a CLI that turns an arbitrarily ordered event history into a
serializable certificate.

## Model

- Commands carry `requestId`, `idempotencyKey`, logical timestamp `ts`,
  `amount`, and `action` (`FREEZE` / `CONFIRM` / `CANCEL`).
- Events are deduplicated by `idempotencyKey`; reusing a key with a different
  payload is a hard error (`IDEMPOTENCY_CONFLICT`).
- The unique serial order is: logical `ts`, then `requestId`, then action rank
  (`FREEZE` < `CONFIRM` < `CANCEL`), then `idempotencyKey`. Replaying any
  physical arrival order of the same history yields the same accepted sequence
  and the same `stateHash`.
- `FREEZE` succeeds only while the pool has enough remaining quota, otherwise
  it is `rejected` (`INSUFFICIENT_QUOTA`) and never oversells.
- `CONFIRM` is valid only from a frozen request; confirming after a rejected
  freeze is `invalid` (`CONFIRM_AFTER_REJECTED_FREEZE`).
- `CANCEL` of a frozen request releases the hold; `CANCEL` after `CONFIRM`
  produces a compensating release (`COMPENSATING_RELEASE`). A logically
  earlier `CANCEL` beats a later `CONFIRM`, which then reports a clear
  `invalid` status with a reason.

## Usage

```sh
node cli.js history.json
```

Input file:

```json
{
  "quota": 10,
  "events": [
    { "requestId": "req-a", "idempotencyKey": "k-a-freeze", "ts": 1, "amount": 6, "action": "FREEZE" }
  ]
}
```

On success the certificate (including `acceptedOrder`, per-event `results`,
`finalState`, and `stateHash`) is printed to stdout with exit code 0. On any
error a standard JSON error object (`{ "error": { "code", "message" } }`) is
printed to stderr and the exit code is 1.

## Tests

```sh
node --test
```

The suite enumerates all 720 arrival permutations of 3 concurrent requests
(6/6/3 against a quota of 10), cross-checks accept/reject/balance against an
independent serial model, and covers idempotent duplicates, late-cancel
conflicts, compensating releases, and replay hash stability.
