# Scheduled Payment Workflow

Node.js 22, standard library only. Payment stages run in fixed order:
`VALIDATED -> FROZEN -> POSTED -> NOTIFIED`.

## Usage

```
node cli.js <command.json|inline-json> <stateDir>
```

Commands:

```json
{ "type": "pay", "paymentId": "p1", "commandId": "c1", "amount": 100,
  "initialBalance": 1000, "crashPoint": "FROZEN", "pauseBefore": "POSTED" }
{ "type": "cancel", "paymentId": "p1", "commandId": "c2" }
```

- `crashPoint` (optional): persist the stage event, then exit with code 99
  before applying the stage effect (simulates a crash).
- `pauseBefore` (optional): stop normally before the named stage
  (test hook to make a cancel arrive at a chosen point).

Behavior:

- Every stage event is persisted (append + fsync) to `<stateDir>/events.log`
  before the stage takes effect; state is rebuilt by replaying the log, so
  restarting resumes incomplete stages and no stage ever applies twice.
- `cancel` before `POSTED`: cancels and releases the freeze (`CANCELLED`).
- `cancel` after `POSTED`: reverse compensation, marked `REFUNDED`;
  the payment is never deleted.
- Same `paymentId` / `commandId` is idempotent: re-issuing a command resumes
  or no-ops, never duplicating accounting.

Output: a JSON certificate on stdout, e.g.
`{"paymentId":"p1","status":"COMPLETED","stages":[...],"amount":100,"balance":900,"frozen":0}`.
Errors exit with code 1 and print `{"error":"<CODE>","message":"..."}`.

## Tests

```
node --test
```
