# clearing-retry

Offline clearing retry planner/executor. Node.js 22, standard library only,
tests use `node:test`. No network access, no dependencies.

## CLI

```
node . retry input.json output.json
```

Exit code `0` on success (including a well-formed `UNSAT` answer), `1` on bad
data (unreadable/invalid JSON, schema violations, bad usage).

## Input format

```json
{
  "accounts": [{ "id": "A", "limit": 100 }],
  "batches": [{ "id": "B1", "start": "2026-10-03T00:00:00Z", "end": "2026-10-03T01:00:00Z" }],
  "transactions": [{
    "id": "T1", "account": "A", "amount": 60,
    "windows": [["2026-10-03T00:00:00Z", "2026-10-03T03:00:00Z"]],
    "routes": ["B1", "B2"],
    "failures": ["B1"]
  }],
  "cancellations": [{ "tx": "T2", "atBatch": "B2", "phase": "before" }]
}
```

- `windows` (optional): a transaction may only be attempted in batches fully
  contained in one of these time windows.
- `routes` (optional): allowed batch ids (routing domain).
- `failures` (optional): batches in which the attempt fails, to drive retries.
- `cancellations[].phase`: `before` (default) cancels when the batch starts;
  `during` cancels while the attempt is running. Cancellation first removes
  all not-yet-started future attempts, then handles the running batch.

## Semantics

- Failed transactions are replayed across retry batches; every retry freezes
  the amount again and unfreezes it on failure.
- Per account per batch, total frozen funds never exceed the account limit.
- A transaction that succeeds is never retried again.
- Planning is backtracking search with forward-checking propagation of
  infeasible routes. When infeasible, the output is `UNSAT` plus a `conflict`:
  a minimal (by inclusion) set of `{account, batch}` pairs that still
  reproduces the infeasibility.
- Crash point: an attempt is `RUNNING` but its freeze record is not committed.
  `recover(model, journal)` rebuilds state from the committed journal only and
  rolls such attempts back to `PENDING` so they can be safely retried; it
  never marks them successful.

## Tests

```
node --test
```

Includes acceptance tests (3-transaction split success, incremental
cancellation, crash recovery to `PENDING`, `UNSAT` on insufficient limit) and
a brute-force enumeration cross-check of the solver for <= 3 transactions and
2 batches.
