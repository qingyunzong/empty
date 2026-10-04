# payrev-ledger

Payment reversal propagation over a dependency graph. Node.js 22, standard
library only, tested with `node:test`.

## Semantics

- Edge `u -> v`: the settlement of `u` depends on `v`.
- `cancel(id, tx)`: `tx` and every transaction reachable from `tx` along
  dependency edges enter `REVERSED`. Members of a strongly connected
  component are mutually reachable, so an SCC is always reversed as a group.
- `restore(id, tx)`: lifts `REVERSED` from `tx` and every reversed
  transaction reachable from it in the current graph.
- `cancel`/`restore` carry a unique event id. Errors: duplicate event id,
  duplicate cancel (already `REVERSED`), restore of a non-reversed or
  unknown transaction, unknown node, unknown/duplicate dependency.

## CLI

Reads NDJSON commands from stdin, writes one JSON result per line. Error
lines are JSON objects (`{"ok":false,"error":{...}}`); the process exits 1
if any line failed, 0 otherwise.

```sh
printf '%s\n' \
  '{"op":"add-dep","u":"a","v":"b"}' \
  '{"op":"add-dep","u":"b","v":"a"}' \
  '{"op":"cancel","id":"e1","tx":"a"}' \
  '{"op":"query"}' | node src/cli.js
```

Commands: `add-dep {u,v}`, `remove-dep {u,v}`, `cancel {id,tx}`,
`restore {id,tx}`, `query {}`.

`query` returns:

- `affected`: sorted set of transactions currently `REVERSED`;
- `components`: SCCs with deterministic ids (`C0`, `C1`, ...), ordered by
  smallest member;
- `topoOrder`: topological order of the condensation DAG (a component
  appears before the components it depends on);
- `certificate`: propagation certificate with `dfsEdges` (deterministic DFS
  forest over the graph) and `crossComponentEdges` (edges between distinct
  SCCs, annotated with component ids).

## Library

```js
import { Ledger, reachable, tarjanSCC } from './src/ledger.js';
```

## Tests

```sh
node --test
```
