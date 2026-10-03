# repair-order-repo

Offline repair work-order version store and CLI. Node.js 22, standard library only.

## Model

An order is `{ id, status, assignee, priority }`. Status flows
`created -> assigned -> in_progress -> done`; `canceled` is reachable from the
first three states. `done` and `canceled` are terminal and reject all further
patches.

## Library

- `src/stateMachine.js` — state enum and transition table.
- `src/repo.js` — `OrderRepo` with `apply(patch)` (returns the inverse patch),
  `undo()` (restores via the inverse patch) and `redo()` (re-validated against
  the state machine). A patch is `{ id, changes: { field: value } }`.
- `src/merge.js` — `mergeOrders(base, local, remote)` three-way merge.
  Different orders merge automatically; different fields of the same order
  merge; the same field changed to different values on both sides conflicts.
  A merged illegal status transition, or any side modifying a terminal order,
  is also a conflict.

## CLI

```
node index.js merge-orders --base base.json --local local.json --remote remote.json --out r.json
```

Exit codes: `0` success (merged orders written to `--out`), `1` merge conflict
(report on stderr), `2` unknown order or invalid patch/input.

## Tests

```
node --test
```
