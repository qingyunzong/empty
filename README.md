# budget-settlement

Offline budget settlement library and CLI. Node.js 22, standard library only.

Each budget category has a periodic limit. Settling a record reserves funds;
cancelling releases them. Concurrency model:

- Snapshot isolation for reads; first-committer-wins on normal keys
  (`E_WRITE_CONFLICT`).
- Predicate conflict detection on budget balances: if a transaction decided to
  insert based on a category's available budget, and another transaction
  committed a settle/cancel in that category after the snapshot, commit fails
  with `E_PRED_CONFLICT` (retry with a fresh snapshot).
- A versioned `(category, status)` secondary index backs balance queries.

## Library

```js
import { BudgetDB, transact } from './src/db.js';

const db = new BudgetDB();
db.setBudget('ops', 100);
transact(db, (tx) => tx.settle({ id: 's1', category: 'ops', amount: 60 })); // auto-retries on E_PRED_CONFLICT
const available = db.begin().available('ops'); // 40
transact(db, (tx) => tx.cancel('s1'));
```

## CLI

```sh
node src/cli.js set-budget --category ops --limit 100
node src/cli.js settle --category ops --amount 60   # prints JSON with id
node src/cli.js cancel --id <id>
node src/cli.js available ops
```

Data is stored in `./budget.json` (override with `--db PATH` or `$BUDGET_DB`).
Success prints JSON on stdout (exit 0); errors print `{"error": CODE, "message": ...}`
on stderr with a non-zero exit. Error codes: `E_BUDGET`, `E_PRED_CONFLICT`,
`E_WRITE_CONFLICT`, `E_NOT_FOUND`, `E_VALIDATION`, `E_USAGE`, `E_STORAGE`.

## Tests

```sh
node --test
```
