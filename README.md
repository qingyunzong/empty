# offline-credit-ledger

Offline account credit/quota library + JSON CLI. Node.js 22, standard library only, tested with `node:test`.

## Model

- Accounts hold a total credit limit (`total`) and a settled amount (`used`).
- `freeze` creates a HOLD (`ACTIVE`) that reduces available credit (`total - used - activeHolds`).
- `pay` settles a HOLD: the amount is deducted permanently (`used += amount`) and the hold becomes `SETTLED`.
- `release` cancels a HOLD (`RELEASED`), restoring available credit.
- `cancelPay` refunds a settled payment (`REFUNDED`) and generates a refund record, restoring `used`.

## Transactions

`ledger.begin()` opens a transaction over a snapshot; reads see only that snapshot. `commit()` validates the observed versions of every touched account balance and hold status; on mismatch it throws `E_CONFLICT` and applies nothing. State mutations and the two secondary indexes — `(account,status)` and `(dueDate,status)` — are updated in the same atomic commit section, so index visibility is always consistent with state.

## Errors

`E_NO_ACCOUNT` · `E_NO_HOLD` · `E_NO_PAYMENT` · `E_INSUFFICIENT` · `E_CONFLICT` · `E_HOLD_NOT_ACTIVE` · `E_PAYMENT_NOT_SETTLED` · `E_VALIDATION`

## CLI

```sh
node src/cli.js '[{"cmd":"createAccount","account":"A","total":100},
                  {"cmd":"freeze","account":"A","amount":40,"dueDate":"2026-01-01","holdId":"h1"},
                  {"cmd":"pay","holdId":"h1","payId":"p1"},
                  {"cmd":"query","account":"A","status":"SETTLED","due-before":"2026-06-01"}]'
```

Accepts a single JSON object or an array (argv or stdin); prints one JSON result per command. `--state FILE` persists the ledger across invocations.

## Tests

```sh
node --test
```
