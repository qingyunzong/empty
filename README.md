# ledger-trust-graph

Directed trust edges between ledgers. An edge `from -> to` means the two
ledgers can reconcile directly in that direction. After every mutation the
graph maintains strongly connected reconciliation zones: ledgers in the same
zone can reach each other, while cross-zone reconciliation only flows along
the one-way component DAG.

Requires Node.js 22+. Standard library only; tests use `node:test`.

## Library

```js
import { TrustGraph } from './src/trust-graph.js';

const graph = new TrustGraph();
graph.addEdge(0, 1);
graph.addEdge(1, 0);
const { snapshotId, hash } = graph.snapshot();
graph.correctDirection(1, 0);
graph.rollback(snapshotId); // restores the exact state + hash
const { sccs, topologicalOrder, certificates } = graph.query();
```

Operations: `addEdge`, `removeEdge`, `correctDirection`, `snapshot`,
`rollback`, `query`, `stateHash`, `nodes`, `edges`.

Rollback truncates the event log at the snapshot point and replays the
surviving prefix, so events deleted before a rollback can never be
resurrected by a later rollback. Snapshots taken after a rollback point are
invalidated.

Errors are `TrustGraphError` with codes: `DUPLICATE_EDGE`, `EDGE_NOT_FOUND`,
`NEGATIVE_ID`, `INVALID_ID`, `UNKNOWN_SNAPSHOT`, `FUTURE_SNAPSHOT`,
`SNAPSHOT_CORRUPT`.

Each SCC certificate contains the representative (smallest member id), the
member list, a digest, and forward/backward paths proving mutual
reachability between the representative and every member. Verify with
`verifySccCertificate(edges, certificate)`.

## CLI

Reads NDJSON commands from stdin, writes one JSON result per line to stdout,
exits non-zero if any line failed.

```sh
printf '%s\n' \
  '{"op":"add-edge","from":0,"to":1}' \
  '{"op":"add-edge","from":1,"to":0}' \
  '{"op":"snapshot"}' \
  '{"op":"query"}' \
  '{"op":"rollback","snapshot":1}' | node src/cli.js
```

Commands: `add-edge`, `remove-edge`, `correct-direction`, `snapshot`,
`rollback` (field `snapshot`), `query`.

## Tests

```sh
node --test
```

`test/scc-crosscheck.test.js` cross-checks the production Kosaraju
implementation against an independent enumeration-based grouping
(Floyd-Warshall reachability + mutual-reachability grouping) for random
graphs with n <= 8, plus an exhaustive sweep of all 3-node graphs.
