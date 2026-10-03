# txn-cancel

Offline library and CLI for cancelling four-stage transactions (trade → fee →
freeze → settle) with reverse compensation into batch domains. Node.js 22,
standard library only, tested with `node:test`.

## Usage

```
node . cancel input.json output.json
```

Exit code `0` on success (business rejections still exit `0`); exit code `1`
for bad usage, unreadable files, malformed JSON, or schema-invalid input.
The overall status (`COMPLETED` / `PARTIAL` / `REJECTED`) is printed to stdout
and the full result is written to the output file.

Library API:

```js
const { CancellationEngine } = require('./lib/engine');
const output = new CancellationEngine(input).processAll();
```

## Input schema

```json
{
  "transactions": [
    {
      "id": "tx1",
      "stages": [
        {
          "id": "fee",
          "type": "trade | fee | freeze | settle",
          "account": "A",
          "amount": 10,
          "status": "completed | reconciled",
          "dependsOn": ["trade"]
        }
      ]
    }
  ],
  "batches": [
    { "id": "b1", "domains": ["trade", "fee"], "quotas": { "A": 100 } }
  ],
  "requests": [
    { "idempotencyKey": "k1", "transactionId": "tx1" }
  ]
}
```

- `dependsOn` lists parent stages; dependencies must be acyclic within a
  transaction. `status` defaults to `completed`, `dependsOn` to `[]`.
- Batch `quotas` map account → recoverable amount.

## Semantics

- **Reverse order**: stages compensate children-first (settle → freeze → fee →
  trade for a linear chain), the reverse of the forward pipeline.
- **Batch domains**: a compensation may only be placed in a batch whose
  `domains` include the stage type.
- **Quota**: per batch and account, the summed compensation amount never
  exceeds the remaining recoverable quota.
- **Reconciled stages** (`status: "reconciled"`) compensate as `reversal`
  (红冲); all others as `delete`.
- **Search**: a backtracking solver maximizes the number of placed stages per
  request; a brute-force enumeration of all batch assignments (≤ 4 stages)
  cross-checks it in `test/solver.test.js`.
- **Conflicts**: unplaceable stages report `INSUFFICIENT_QUOTA` or
  `NO_DOMAIN_BATCH`, the infeasible batches with remaining quota, and the
  dependency path of parent stages blocked as a consequence.
- **Pending**: unplaced compensations stay recoverable and are retried by
  later requests for the same transaction.
- **Idempotency**: a repeated `idempotencyKey` replays the stored result
  (`replayed: true`) without re-executing or consuming quota again.

## Output

Top-level `status` is `COMPLETED` when every request completed, `REJECTED`
when all were rejected, otherwise `PARTIAL`. Each request result carries its
own `status`, the compensation `sequence` (batch + mode per stage),
recoverable `pending` stages, and `conflicts`. `state` contains the
incrementally maintained global compensation sequence, remaining quotas, and
all pending compensations.

## Tests

```
node --test
```
