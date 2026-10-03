# payment-channel-network

Payment channel network library + CLI. Node.js 22, standard library only,
tests via `node:test`. No dependencies, works fully offline.

## Model

Payment channels form an undirected multigraph. Each edge has a `bandwidth`
and a maintenance state (`open` / closed). Banks cancel payments in atomic
batches: every payment's endpoints must stay connected through open edges,
otherwise the whole batch fails and nothing is cancelled. When a batch fails
because closing an edge under maintenance split the graph, the error carries
a **bridge certificate** (all bridges of the open-edge graph, the connected
components, and which maintenance edges are bridges of the full graph).

## CLI

Reads NDJSON commands from stdin, writes one NDJSON response per line:

```sh
node cli.js << 'EOF'
{"type":"add-edge","id":"e1","a":"A","b":"B","bandwidth":100}
{"type":"add-edge","id":"e2","a":"B","b":"C","bandwidth":50}
{"type":"close-edge","id":"e2"}
{"type":"cancel-batch","batchId":"b1","payments":[{"id":"p1","from":"A","to":"C","amount":3}]}
EOF
```

Commands: `add-edge`, `close-edge`, `open-edge`, `cancel-batch`.
A successful `cancel-batch` returns each payment's path (fewest hops,
lexicographically smallest among ties), all bridges, and the connected
components. Errors are reported per line with a `code`:
`UNKNOWN_NODE`, `UNKNOWN_EDGE`, `EDGE_ALREADY_CLOSED`, `EDGE_ALREADY_OPEN`,
`SELF_LOOP`, `EMPTY_BATCH`, `DUPLICATE_EDGE`, `DUPLICATE_PAYMENT`,
`INVALID_BANDWIDTH`, `DISCONNECTED` (with `bridgeCertificate`),
`INVALID_JSON`, `UNKNOWN_COMMAND`, `INVALID_INPUT`, `INVALID_PAYMENT`.

## Library

```js
const { PaymentNetwork } = require('./index');
const net = new PaymentNetwork();
net.addEdge({ id: 'e1', a: 'A', b: 'B', bandwidth: 100 });
net.cancelBatch({ batchId: 'b1', payments: [{ id: 'p1', from: 'A', to: 'B' }] });
```

Graph algorithms in `lib/algorithms.js`: `connectedComponents`,
`tarjanBridges`, `enumerationBridges` (delete-each-edge reference),
`shortestPath` (hop-minimal, lexicographic tie-break).

## Tests

```sh
node --test
```

Includes acceptance scenarios (dual-path reroute, atomic failure on unique
bridge with certificate, recovery after reopen with lexicographic path
check) and a property test cross-checking Tarjan bridges against
delete-each-edge enumeration on random graphs with n <= 8.
