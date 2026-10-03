# payment-reversal

Payment reversal propagation library and NDJSON CLI. Node.js 22, standard
library only (`node:test` for tests). No dependencies.

## Model

- Directed edge `u -> v`: settlement of `u` depends on settlement of `v`.
- `cancel(t)` propagates along dependency edges: every transaction reachable
  from `t` enters `REVERSED`. Members of one strongly connected component
  mutually depend, so the whole SCC is reversed as a group.
- `restore(t)` is the symmetric operation over the current graph: every
  `REVERSED` transaction reachable from `t` returns to `ACTIVE`.
- `cancel`/`restore` carry a unique event id. Cancelling an already
  `REVERSED` transaction, restoring a transaction that is not `REVERSED`,
  touching an unknown transaction, or reusing an event id is an error.

## Library

```js
import { Ledger } from './index.js';

const ledger = new Ledger();
ledger.addDep('a', 'b');
ledger.addDep('b', 'a');
const report = ledger.cancel('a', 'evt-1');
```

A `cancel`/`restore` report contains:

- `affected`: sorted set of transactions that changed state;
- `scc`: map from each affected transaction to its component id (`C0`, ...);
- `components` / `componentTopoOrder` / `condensationEdges`: the condensation
  DAG of SCCs in deterministic topological order (edge `Ci -> Cj` implies
  `i < j`);
- `certificate`: propagation certificate with `root`, `dfsEdges` (DFS tree
  edges of the propagation traversal) and `crossComponentEdges` (explored
  edges whose endpoints lie in different SCCs).

## CLI

Reads NDJSON from stdin, writes one JSON result per line to stdout. Error
lines are JSON objects (`{"ok":false,"error":...,"code":...,"line":n}`); the
process exits with code 1 if any line failed, 0 otherwise.

```sh
node src/cli.js <<'NDJSON'
{"op":"add-dep","from":"a","to":"b"}
{"op":"add-dep","from":"b","to":"c"}
{"op":"cancel","tx":"a","event":"e1"}
{"op":"remove-dep","from":"b","to":"c"}
{"op":"restore","tx":"a","event":"e2"}
NDJSON
```

Ops: `add-dep` (`from`, `to`), `remove-dep` (`from`, `to`),
`cancel` (`tx`, `event`), `restore` (`tx`, `event`).

## Tests

```sh
node --test
```

- `test/ledger.test.js`: acceptance scenarios — SCC group reversal in a
  cyclic guarantee network, successor-only reversal in a DAG, component
  split via `remove-dep` followed by `restore`, and all error paths.
- `test/scc-crosscheck.test.js`: for n <= 8 random graphs, the library's
  Tarjan SCC and reachability are cross-checked against brute-force
  reachable-set enumeration and an independent Kosaraju implementation.
- `test/cli.test.js`: end-to-end NDJSON sessions, including exit codes.
