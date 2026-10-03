# clearing-circulation

Feasible-circulation checker for financial clearing networks. Every edge has a
lower bound (settlement that must happen) and an upper bound (capacity). After
each mutation the library decides whether a circulation exists — every node's
inflow equals its outflow and every edge stays within `[lower, upper]` — and
either returns per-edge settlement amounts or an infeasibility certificate.

Node.js 22, standard library only, tests via `node:test`.

## Library

```js
const { Ledger, solveCirculation } = require('./index');

const ledger = new Ledger();
ledger.applyEvent({ op: 'add-edge', id: 'e1', from: 'A', to: 'B', lower: 2, upper: 5 });
ledger.applyEvent({ op: 'add-edge', id: 'e2', from: 'B', to: 'A', lower: 2, upper: 5 });
ledger.evaluate();
// { feasible: true, flows: { 'A->B': 2, 'B->A': 2 } }

ledger.applyEvent({ op: 'update-edge', id: 'e3', from: 'B', to: 'A', lower: 0, upper: 1 });
ledger.evaluate();
// { feasible: false,
//   deficits: [{ node: 'A', amount: 1 }, ...],
//   cut: { nodes: [...], lowerOut: 2, upperIn: 1, violation: 1 } }

ledger.undo('e3'); // back to feasible
ledger.redo('e3'); // infeasible again
```

- `solveCirculation(edges)` — one-shot solver for `[{ from, to, lower, upper }]`.
- Feasible: `{ feasible: true, flows }` with integral per-edge amounts.
- Infeasible: `{ feasible: false, deficits, cut }`, never a pseudo-flow.
  `cut.nodes` is a node set `Y` with `lower(Y -> V\Y) > upper(V\Y -> Y)`
  (a Hoffmann-criterion violation); `deficits` lists nodes whose required
  outflow could not be routed, with amounts.
- `undo(id)` / `redo(id)` address the most recent applied / undone event;
  an id mismatch throws `LedgerError` with code `UNDO_MISMATCH` / `REDO_MISMATCH`.

## CLI

`src/cli.js` reads NDJSON commands from stdin and writes one JSON result per
line to stdout. Any error prints a JSON error object and exits with code 1.

```sh
printf '%s\n' \
  '{"op":"add-edge","id":"e1","from":"A","to":"B","lower":2,"upper":5}' \
  '{"op":"add-edge","id":"e2","from":"B","to":"A","lower":2,"upper":5}' \
  '{"op":"undo","id":"e2"}' | node src/cli.js
```

Commands: `add-edge`, `update-edge` (partial bounds allowed), `remove-edge`,
`undo`, `redo`, `check` (evaluate without mutating). Every mutation event
carries a unique `id`; `undo`/`redo` reference those ids.

Error codes: `LOWER_EXCEEDS_UPPER`, `NEGATIVE_CAPACITY`, `UNKNOWN_NODE`,
`UNKNOWN_EDGE`, `EDGE_EXISTS`, `DUPLICATE_EVENT_ID`, `UNDO_MISMATCH`,
`REDO_MISMATCH`, `UNKNOWN_OP`, `PARSE_ERROR`, `INVALID_*`.

## Method

Lower bounds are removed by the standard transformation `f = lower + f'` with
node demands balanced through a super source/sink; feasibility is decided by a
Dinic max-flow. The certificate is the residual min-cut: the sink-side node set
violates the Hoffmann cut condition. Tests cross-check the solver against an
independent subset-cut criterion and brute-force enumeration of all integral
flows for small graphs (`n <= 7`, capacities `<= 10`).

## Tests

```sh
node --test
```
