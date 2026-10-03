# freeze

Offline, single-machine lot-freeze propagation library and CLI. Node.js 22, standard library only.

## Model

- Batch graph edges are `child -> parent` (a derived batch points at its source batches).
- A hold has `id`, `lot`, `type` (`supplier` | `customer`), and `severity` (number or `null`).
  `null` severity means the severity is unknown, but the freeze is still effective.
- `supplier` freezes propagate downstream to every derived batch; `customer`
  freezes propagate upstream to every source batch.
- Effective severity per lot is the numeric maximum of all triggering holds;
  if any triggering hold has `null` severity, the result severity is `null`.
  The `reasons` set keeps every triggering hold id.
- Split/merge (adding edges) and hold release are incremental transactions;
  the closure is recomputed after every transaction, so released holds leave
  no residual reasons. `undo` restores the most recent transaction.
- A cyclic graph is invalid input and is rejected before any transaction is
  processed; no partial state is committed.

## CLI

```
node cli.js load <graph.json>          # {"edges": [[child, parent], ...], "merge"?: bool, "holds"?: [...]}
node cli.js hold --id H1 --lot L1 --type supplier --severity 3
node cli.js release --id H1
node cli.js query [--lot L1]
node cli.js undo
```

State persists to `.freeze-state.json` (override with `--state <path>` or `FREEZE_STATE`).

## Library

```js
const { FreezeEngine } = require('./src/engine');
const engine = new FreezeEngine();
engine.loadGraph({ edges: [['M', 'A'], ['C', 'M']] });
engine.addHold({ id: 'h1', lot: 'A', type: 'supplier', severity: 3 });
engine.query('M'); // { lot: 'M', frozen: true, severity: 3, reasons: ['h1'] }
```

## Tests

```
node --test
```
