# order-refund

Order refund library and CLI. Node.js 22, standard library only, tested with `node:test`.

A settled payment consists of three components: `merchant` (merchant funds),
`commission` (platform commission) and `tax`. All amounts are integers.

## Refund model

- A refund request carries `refundId`, `paymentId` and `amount`.
- Partial refunds are split across the three components proportionally to the
  original payment shares; fractional remainders are distributed with the
  largest-remainder method (ties break in merchant, commission, tax order).
- The cumulative active (frozen + posted) refunds of a payment never exceed
  the original payment total; overflows fail with `REFUND_EXCEEDED` and leave
  the ledger untouched.
- A refund first freezes the corresponding funds (`freeze` event), then
  registers reverse entries (`post` event).
- Cancelling before registration only releases the freeze (`release` event);
  cancelling after registration posts compensating entries (`compensate`
  event) that exactly reverse the registered entries.
- A repeated `refundId` is idempotent: it returns the first result and never
  appends another event, so replays cannot double-post.

## CLI

    node cli.js <history.jsonl> [command-json]

Commands are JSON, read from the argument or stdin. A JSON array is processed
as a sequential batch. Every state change is appended to the history file as
one JSONL event; state is rebuilt by replaying it.

Ops:

- `{"op":"payment","paymentId":"p1","merchant":70,"commission":20,"tax":10}`
- `{"op":"refund","refundId":"r1","paymentId":"p1","amount":40}`
- `{"op":"register","refundId":"r1"}`
- `{"op":"cancel","refundId":"r1"}`
- `{"op":"snapshot"}`

Output is JSON on stdout. On error the process exits with code 1 and prints
`{"error":{"code":"...","message":"..."}}` (batch mode also includes the
`results` collected before the failure).

Error codes: `VALIDATION_ERROR`, `PAYMENT_EXISTS`, `PAYMENT_NOT_FOUND`,
`REFUND_NOT_FOUND`, `REFUND_EXCEEDED`, `INVALID_STATE`, `UNKNOWN_OP`,
`UNKNOWN_EVENT`, `INVALID_JSON`, `USAGE`, `INTERNAL_ERROR`.

## Tests

    node --test

- `test/ledger.test.js` — refund splits, idempotency, replay, over-limit,
  cancel before/after registration, coded errors.
- `test/enumerator.test.js` — independent enumerator: for every original
  total <= 20 and 3 candidate refunds, enumerates all subsets, recomputes
  cumulative splits with a separate implementation and checks the boundaries.
- `test/cli.test.js` — end-to-end CLI runs: JSONL persistence, idempotent
  replay, error exit codes.
