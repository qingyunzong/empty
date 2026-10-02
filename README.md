# offline-credit-ledger

Offline account credit ledger (Node.js 22, standard library only) with snapshot
transactions and secondary indexes, plus a JSON-driven CLI.

## Model

- Each account has a total credit limit (`total`); `available = total - sum(HELD holds)`.
- `freeze` creates a HOLD and reduces available credit (`E_INSUFFICIENT` when exceeded).
- `pay` settles a hold: deducts from `total` and releases the hold (status `SETTLED`).
  An amount above the hold is allowed up to the remaining available credit.
- `release` cancels a hold and restores available credit.
- `cancelPay` cancels a payment and generates a refund (`total` is credited back).
- Unknown accounts yield `E_NO_ACCOUNT`.

## Transactions

`store.begin()` starts a snapshot-read transaction. Reads record base versions;
writes are buffered. `commit()` validates account balance versions and hold
version+status, then applies record changes and both secondary indexes —
`(account, status)` and `(dueDate, status)` — atomically. Conflicts throw
`E_CONFLICT`; retry the transaction against the new state.

## CLI

```sh
node src/cli.js --db ledger.json '{"cmd":"createAccount","account":"A","total":1000}'
node src/cli.js --db ledger.json '{"cmd":"freeze","account":"A","holdId":"h1","amount":100,"dueDate":"2026-01-01"}'
node src/cli.js --db ledger.json '{"cmd":"pay","holdId":"h1","paymentId":"p1"}'
node src/cli.js --db ledger.json '{"cmd":"release","holdId":"h1"}'
node src/cli.js --db ledger.json '{"cmd":"cancelPay","paymentId":"p1"}'
node src/cli.js --db ledger.json query --account A --status HELD --due-before 2026-02-01
```

Output is a single JSON line: `{"ok":true,"result":...}` or
`{"ok":false,"error":"E_*"}` (exit code 1 on error).

## Tests

```sh
node --test
```
