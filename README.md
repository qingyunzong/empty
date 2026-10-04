# payment-channel-network

Node.js 22, standard library only. Undirected payment-channel graph with
bandwidth + maintenance state per edge, atomic batch cancellation, bridge
certificates, and lexicographic routing.

## Library

```js
import { PaymentNetwork } from './src/network.js';

const net = new PaymentNetwork();
net.addEdge('A', 'B', 100);          // bandwidth, edge starts open
net.closeEdge('A', 'B');             // maintenance; returns bridgeCertificate if it is a bridge
net.openEdge('A', 'B');              // back in service
net.cancelBatch([{ id: 'p1', from: 'A', to: 'C' }]);
// -> { cancelled: [{ id, from, to, path }], bridges: [[a, b], ...], affectedComponents: [[...]] }
```

- `cancelBatch` is atomic: if any payment's endpoints are not connected
  through open edges, the whole batch is rejected (`BATCH_NOT_ROUTABLE`)
  and no state changes.
- Paths are the lexicographically smallest shortest paths.
- `closeEdge` on a bridge returns a certificate describing the components
  the graph splits into.
- Errors (`NetworkError.code`): `SELF_LOOP`, `DUPLICATE_EDGE`, `UNKNOWN_NODE`,
  `UNKNOWN_EDGE`, `EDGE_ALREADY_CLOSED`, `EDGE_NOT_CLOSED`, `EMPTY_BATCH`,
  `INVALID_BANDWIDTH`, `BATCH_NOT_ROUTABLE`.

## CLI

Reads NDJSON commands from stdin, writes one NDJSON response per line.

```
{"cmd":"add-edge","a":"A","b":"B","bandwidth":100}
{"cmd":"close-edge","a":"A","b":"B"}
{"cmd":"open-edge","a":"A","b":"B"}
{"cmd":"cancel-batch","payments":[{"id":"p1","from":"A","to":"C"}]}
{"cmd":"snapshot"}
```

```sh
node src/cli.js < commands.ndjson
```

## Tests

```sh
node --test
```

Includes a property test cross-checking the Tarjan bridge algorithm against
delete-one-edge component enumeration for all graphs with n <= 8.
