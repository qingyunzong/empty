# splitpay

Multi-channel payment split ledger with compensation and crash recovery.
Node.js 22, standard library + `node:test` only.

## Model

A payment consists of three branches: `bank` (银行卡), `coupon` (券), `points` (积分).
Branch amounts are integer cents and may be zero. The flow per payment:

1. `register` declares the expected amount of every branch.
2. Each branch reports `branch_success` (amount must match the expectation) or
   `branch_failed`.
3. When all three branches succeed, the payment is merged and split into
   `merchant` / `fee` / `tax` at a fixed 94:5:1 ratio. Each share is
   `floor(total * ratio / 100)`; the remainder (0–2 cents) is topped up one cent
   at a time on the largest base shares (ties: merchant > fee > tax), so the
   split always sums to the payment total and the remainder is recomputable.
4. If any branch fails or reports a mismatched amount, every branch that already
   succeeded is compensated (a reverse `compensate` record) and the payment is
   `FAILED`. A success arriving late after a failure is compensated immediately.

## Guarantees

- **Idempotency**: duplicate `branch_success` / `branch_failed` / `register`
  notifications for the same `paymentId` + `branchId` are ignored; a settled or
  failed payment never splits or compensates twice.
- **Recovery**: every mutation is appended to `<workdir>/events.log`. On startup
  the log is replayed; a payment that crashed before its split or compensation
  was written is completed automatically.
- **Validation**: negative or non-integer amounts, unknown branches, unknown
  payments and conflicting re-registrations are rejected with coded errors.
  Zero-amount branches are valid and settle to a zero split.

## CLI

```
node cli.js <event.json | JSON string> <workdir>
```

Events:

```json
{"type":"register","paymentId":"p1","branches":{"bank":100,"coupon":50,"points":25}}
{"type":"branch_success","paymentId":"p1","branchId":"bank","amount":100}
{"type":"branch_failed","paymentId":"p1","branchId":"coupon","reason":"declined"}
```

On success the CLI prints a JSON certificate (payment status, branch states,
split, compensations) and exits 0. On error it prints
`{"error":"CODE","message":"..."}` to stderr and exits 1. Error codes:
`INVALID_ARGS`, `INVALID_JSON`, `INVALID_EVENT`, `INVALID_PAYMENT_ID`,
`INVALID_BRANCH`, `INVALID_BRANCHES`, `INVALID_AMOUNT`, `UNKNOWN_PAYMENT`,
`AMOUNT_MISMATCH`, `CONFLICT`, `INTERNAL`.

## Library

```js
const { Ledger } = require('./src/ledger');
const ledger = new Ledger('/path/to/workdir');
ledger.register('p1', { bank: 100, coupon: 50, points: 25 });
ledger.branchSuccess('p1', 'bank', 100);
const cert = ledger.certificate('p1');
```

## Tests

```
node --test
```

The test suite enumerates every branch success/failure mask (2^3) and every
integer total up to 5 yuan (500 cents) with an independent reference splitter,
and covers idempotency, crash recovery, zero-amount and negative-amount edges.
