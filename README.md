# creditnet

Trusted-network credit freezing library and CLI. Nodes are accounts; directed
edges are credit commitments with integer capacities. Freezing allocates
capacity across the network via max flow; insufficient credit is rejected with
a min-cut certificate. Node.js 22, standard library only.

## CLI

Reads NDJSON commands from stdin, writes one JSON result per line to stdout.
Hard errors (invalid JSON, unknown command, duplicate/over release, unknown
source, ...) still produce JSON output and make the process exit with code 1.
A capacity-insufficient freeze is a business-level rejection (`ok: false` with
a cut certificate) and does not affect the exit code.

```sh
node cli.js <<'NDJSON'
{"cmd":"add-edge","from":"bank","to":"alice","capacity":10}
{"cmd":"add-edge","from":"alice","to":"shop","capacity":6}
{"cmd":"set-capacity","from":"alice","to":"shop","capacity":8}
{"cmd":"freeze","source":"bank","target":"shop","amount":5}
{"cmd":"release","id":"freeze-1","amount":2}
NDJSON
```

Commands:

- `add-edge` `{from,to,capacity}` — create a directed credit edge.
- `set-capacity` `{from,to,capacity}` — adjust capacity (never below frozen).
- `freeze` `{source,target,amount,id?}` — freeze `amount` from `source` to
  `target`. Success: `{ok:true,id,flows:[{from,to,amount}]}`. Failure:
  `{ok:false,error,maxFreezable,cut:{capacity,sourceSide,customerSide,edges}}`
  where `cut.capacity` equals the maximum freezable amount and the state is
  unchanged.
- `release` `{id,amount?}` — release a freeze by id (all remaining if
  `amount` omitted). Duplicate, over- and unknown-id releases are errors.

## Library

```js
const { CreditNetwork } = require('./src/credit-network');
const net = new CreditNetwork();
net.addEdge('bank', 'alice', 10);
const r = net.freeze({ source: 'bank', target: 'alice', amount: 4 });
net.release({ id: r.id, amount: 1 });
```

## Tests

```sh
node --test
```

Includes acceptance tests (multi-path freeze, partial release + re-freeze,
rejection with tight cut certificate) and randomized cross-checks of the
library max flow against an independent Ford-Fulkerson implementation and
exhaustive cut-set enumeration (n <= 8, capacities <= 20).
