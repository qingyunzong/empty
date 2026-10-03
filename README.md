# maintpack

Offline device maintenance package selection library and CLI (Node.js 22, no dependencies).

Each task has an `id`, a `priority`, a cost interval `[cl, ch]` and a duration interval
`[dl, dh]`; all values are exact rationals. Tasks may declare `requires` (precedence).
A selected set must be closed under precedence (selecting a task selects all its
ancestors), and its worst-case sums must satisfy `sum(ch) <= budget` and
`sum(dh) <= durationLimit` (equality is accepted). The solver maximizes the total
priority; ties are broken by the lexicographically smallest sorted id sequence.

## Rationals

Accepted forms: safe-integer JSON numbers, or strings `"3"`, `"-1.25"`, `"3/4"`.
Anything else (non-integer JSON numbers, `"1/0"`, `"abc"`, ...) raises `E_RATIONAL`.

## Library

```js
import { MaintenanceStore } from './src/store.js';
import { solveSelection, verifyCertificate } from './src/solver.js';
import { parseRational } from './src/rational.js';

const store = new MaintenanceStore();
store.importBatch([
  { id: 'a', priority: '3/2', cost: ['1/2', '1'], duration: ['0', '1/4'] },
  { id: 'b', priority: '1', cost: ['0', '1'], duration: ['0', '1/4'], requires: ['a'] },
]); // atomic: any E_RATIONAL / E_INTERVAL / E_DUPLICATE / E_CYCLE rolls back the whole batch
store.undo();
store.redo();

const res = solveSelection(store.tasks, parseRational('1'), parseRational('1/2'));
// res: { status, selected, prioritySum, costInterval, durationInterval, reasons, certificate }
verifyCertificate(store.tasks, parseRational('1'), parseRational('1/2'), res.certificate);
```

`solveSelection` returns `{ status: 'E_UNSAT' }` when no feasible set exists
(negative budget or duration limit).

## CLI

Reads JSON commands from stdin (a JSON array, a single object, or NDJSON) and prints
one JSON response per line:

```sh
echo '[{"op":"import","tasks":[{"id":"a","priority":"3/2","cost":["1/2","1"],"duration":["0","1/4"]}]},
       {"op":"solve","budget":"1","durationLimit":"1/2"}]' | node src/cli.js
```

Commands: `import` (`{op, tasks}`), `undo`, `redo`, `state`,
`solve` (`{op, budget, durationLimit}`), `verify` (`{op, budget, durationLimit, certificate}`).
Error codes: `E_RATIONAL`, `E_UNSAT`, `E_INTERVAL`, `E_DUPLICATE`, `E_CYCLE`,
`E_UNKNOWN_TASK`, `E_UNKNOWN_OP`, `E_JSON`.

## Tests

```sh
node --test
```
