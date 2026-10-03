# credit-network

Trusted-credit network for Node.js 22 (standard library only). Nodes are
accounts; directed edges are credit commitments with integer capacities.
Freezing moves credit flow from a funding source to a customer account and
occupies edge capacity immediately; releases free it again by freeze id.

## Library

```js
import { CreditNetwork } from './lib/network.js';

const net = new CreditNetwork();
net.addEdge('S', 'A', 5);          // directed credit edge with capacity
net.setCapacity('S', 'A', 7);      // must stay >= frozen amount on the edge
const r = net.freeze('S', 'C', 4); // -> flow decomposition, or cut certificate
net.release(r.freezeId, 2);        // partial release; omit amount for full
net.maxFlowValue('S', 'C');        // currently freezable amount
```

- `freeze` success: `{ ok: true, freezeId, flows: [{from,to,amount}], paths: [...] }`
- `freeze` rejection: `{ ok: false, reason: 'insufficient-capacity', maxFreezable, cut: { nodes, edges, capacity } }`
  where `cut.nodes` is the unreachable customer side of a min cut and
  `cut.capacity === maxFreezable`. State is left unchanged.
- Errors (`UNKNOWN_SOURCE`, `UNKNOWN_FREEZE`, `DUPLICATE_RELEASE`,
  `OVER_RELEASE`, `CAPACITY_BELOW_FROZEN`, ...) throw `CreditError` with a
  `code` field.

## CLI

Reads NDJSON commands from stdin, writes one JSON response per line:

```
{"cmd":"add-edge","from":"S","to":"A","capacity":5}
{"cmd":"freeze","source":"S","target":"C","amount":4}
{"cmd":"release","freezeId":"f1","amount":2}
```

A declined freeze prints the certificate and processing continues (exit 0).
Command errors print `{"ok":false,"code":...,"error":...}` and exit with
code 1.

## Tests

```
node --test
```

Includes cross-checks of the built-in Edmonds-Karp max-flow against an
independent Ford-Fulkerson implementation and brute-force min-cut
enumeration for random networks with n <= 8 and capacities <= 20.
