# trust-ledger

Directed trust edges between ledgers. Ledgers in the same strongly connected
reconciliation zone can reach each other; across zones reconciliation follows
the component DAG in one direction only. Node.js 22, standard library only.

## Library

```js
import { LedgerNetwork } from './src/ledger.js';

const net = new LedgerNetwork();
net.addEdge(0, 1);
net.correctDirection(0, 1);   // now 1 -> 0
net.removeEdge(1, 0);
const { snapshot, hash } = net.snapshot();
net.rollback(snapshot);       // restores the exact snapshotted state
net.query();                  // { components, topoOrder, componentDag, certificates }
```

`query()` returns the SCCs, their topological order, the condensation DAG and,
per SCC, a certificate: the representative (smallest node id) plus explicit
paths proving every member reaches the representative and vice versa.
`snapshot()` returns a sequential id and a SHA-256 hash of the canonical graph
state; `rollback(id)` restores that state exactly (edges deleted before the
snapshot stay deleted).

## CLI

Reads NDJSON commands from stdin, writes one JSON result per line:

```
{"op":"add-edge","from":0,"to":1}
{"op":"remove-edge","from":0,"to":1}
{"op":"correct-direction","from":0,"to":1}
{"op":"snapshot"}
{"op":"rollback","snapshot":1}
{"op":"query"}
```

Errors are reported as `{"error": code, "message": ...}` with codes
`duplicate-edge`, `missing-edge`, `negative-id`, `invalid-id`,
`unknown-snapshot`, `future-snapshot`, `unknown-op`, `invalid-command`.

## Tests

```
node --test
```

Includes a cross-check of the Kosaraju SCC implementation against brute-force
mutual-reachability grouping for all graphs with n <= 8 (randomized, plus
exhaustive for n = 3).
