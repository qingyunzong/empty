# provenance-audit

Offline, single-machine quality-audit toolkit (Node.js 22, standard library only).
Proves that a finished batch does **not** contain a given raw-material batch
(non-reachability certificate), or exhibits one lineage path that does
(reachability certificate). Certificates are bound to a graph version hash and
are verifiable offline by any third party holding the same graph snapshot.

## Library

```js
import { buildGraph, proveReach, proveNonreach, verify, firstContamination } from './src/index.js';

const g = buildGraph(nodes, edges);          // nodes: string[], edges: [from,to][]
proveReach(g, 'RAW1', 'PROD');               // -> reach certificate (path + per-edge hash chain)
proveNonreach(g, 'CLEAN', 'PROD');           // -> nonreach certificate (closed reachable set + boundary edges)
verify(g, proof);                            // -> VALID | CERT_INVALID | NO_SUCH_NODE | VERSION_MISMATCH
firstContamination(g, ['RAW1','RAW2'], 'SHIP'); // -> { source, path, firstEdge } | null
```

- Graph version = SHA-256 over the canonical (sorted, deduped) node/edge sets.
- Reach cert: `path`, `edges`, and `chain` where `chain[0]=H(reach-chain|version|s)`
  and `chain[i+1]=H(chain[i]|edge_i)` — a missing/altered layer breaks verification.
- Nonreach cert: exact BFS reachable set from `s` plus the full boundary edge list
  (every edge whose source is in the set); the verifier recomputes both from the
  versioned graph, so stale certs → VERSION_MISMATCH, fake sets → CERT_INVALID.
- Proof search has a step budget; exhaustion raises `PROVE_TIMEOUT` and is never
  reported as `NO_PATH`.

## CLI

```
node cli.js build --nodes nodes.json --edges edges.json [--dir .audit]
node cli.js prove_reach    --s A --t B [--out proof.json] [--max-steps N]
node cli.js prove_nonreach --s A --t B [--out proof.json]
node cli.js verify --proof proof.json          # prints VALID | CERT_INVALID | NO_SUCH_NODE | VERSION_MISMATCH
node cli.js contaminate --sources A,B --t T    # prints { source, path, firstEdge }
```

`--nodes`/`--edges`/`--proof` accept a JSON file path or an inline JSON literal.
Verify exit codes: 0 = VALID, 1 = any rejection. Prove errors: 2 = NO_PATH /
PATH_EXISTS, 3 = PROVE_TIMEOUT, 4 = NO_SUCH_NODE.

## Tests

```
node --test
```

See `RESULTS.md` for real output. Limits: n ≤ 500, m ≤ 5000 (BFS, O(n+m)).
