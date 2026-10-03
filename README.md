# idempotent-payments

Offline idempotent payment/cancel library and CLI. Node.js 22, standard library only.

## Design

- **Idempotency**: every request carries a client `requestId`. The first committed
  result is stored under `request/<requestId>` in the same transaction as the
  business change, so a duplicate `requestId` returns the first result and never
  repeats the balance mutation.
- **WAL**: `wal.log` (JSON lines, fsync after every record) with `BEGIN` /
  `CHANGE` / `COMMIT` records. `BEGIN` carries the durable request spec used by
  `retry`.
- **MVCC**: each key keeps a version chain; every committed transaction is
  stamped with a new global version. Recovery replays the WAL: transactions
  with a `COMMIT` record are applied, transactions without one are rolled back.
- **Crash points**: `P1` = after business changes, before `COMMIT` (rolled back
  on restart; `retry` creates a new successful transaction). `P2` = after
  `COMMIT`, before the response (survives; `retry` returns the original
  transaction). Neither can double-charge.

## CLI

```
node cli.js pay    --request-id R [--account A] --amount N [--data-dir D] [--crash-at P1|P2]
node cli.js cancel --request-id R --txn-id T [--data-dir D] [--crash-at P1|P2]
node cli.js retry  --request-id R [--data-dir D] [--crash-at P1|P2]
node cli.js get    [--txn-id T | --request-id R | --balance [--account A]] [--data-dir D]
```

Exit codes: `0` ok, `1` business error (`E_NOT_FOUND`, `E_INVALID_STATE`,
`E_INSUFFICIENT`, ...), `2` usage error or simulated crash.

## Library

```js
import { PaymentService } from './src/payments.js';
const svc = PaymentService.open('./paydb');
svc.pay({ requestId: 'r1', amount: 100 });            // { status: 'ok', txnId: 'T000001', ... }
svc.pay({ requestId: 'r1', amount: 100 });            // same result, no re-charge
svc.cancel({ requestId: 'c1', txnId: 'T000001' });    // refund
svc.retry({ requestId: 'r1' });                       // first result / re-execute after crash
svc.close();
```

## Tests

```
node --test
```

- `test/acceptance.test.js` — the three acceptance scenarios.
- `test/model.test.js` — exhaustive length-4 request-sequence enumeration plus
  seeded random length-12 sequences with random P1/P2 crashes, cross-checked
  after every request (through a full reopen/recovery) against an independent
  in-memory model's mapping tables (requestId→result, txnId→transaction).
- `test/cli.test.js` — CLI end-to-end, including crash flags.
