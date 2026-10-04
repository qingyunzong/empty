# bond-distribution-tree

Offline, single-machine bond distribution tree on Node.js 22 stdlib only
(`node:test`, `node:crypto`, `node:fs`). No dependencies.

## Model

Each node: `{ id, parentId, faceValue, lineLimit, terms, state, occupied }`.
`occupied` is the live distributed face value in the node's subtree and is
maintained incrementally; `postOrderOccupancy(id)` recomputes it independently
via post-order traversal.

## Library

```js
import { BondTree } from './src/bondtree.js';

const tree = new BondTree('./data');        // loads ./data/state.json if present
tree.addNode({ id: 'A', parentId: 'R', faceValue: 100, lineLimit: 5000, terms: 'fixed rate bond' });
const cert = tree.revokeNode('A');          // atomic upward compensation to the root
tree.deleteNode('A');                       // only without live children
tree.phrase('fixed rate');                  // [{ nodeId, positions }]
tree.near('fixed bond', 4);                 // proximity window k=4
tree.postOrderOccupancy('R');               // independent recomputation
tree.verifyCertChain();                     // root certificate hash chain
```

- `revokeNode` releases the node's `faceValue` at every ancestor level up to
  the root. If any level's occupancy cannot cover the release, **no level
  changes** (check-then-apply). The certificate records per-level
  before/after occupancy, proximity hit positions of the node's terms, and
  chains (`prevHash`/`hash`, sha256) into the root certificate hash.
- `deleteNode` physically removes a wrongly entered node and incrementally
  removes its positions from the index; nodes with live children are rejected.
- The positional index (`src/posindex.js`) keeps postings decoded in memory
  and persists them delta + varint compressed; phrase and proximity (NEAR/k)
  queries are supported.

## CLI

```sh
node cli.js add    --data D --id A --parent R --face 100 --limit 5000 --terms "fixed rate bond"
node cli.js revoke --data D --id A
node cli.js delete --data D --id A
node cli.js phrase --data D --q "fixed rate"
node cli.js near   --data D --q "fixed bond" --k 4
node cli.js show   --data D [--id A]
node cli.js certs  --data D        # root cert hash + chain validity
```

## Tests

```sh
node --test
```

Acceptance coverage:

1. Three-level compensation: every certificate level equals an independent
   post-order occupancy recomputation (`test/bondtree.test.js`).
2. Insufficient level quota: whole tree (and persisted state) unchanged.
3. Phrase/proximity results match brute-force window enumeration
   (`testlib/helpers.js`); deleting a node with children fails; a deleted
   childless node stays invisible after restart.
