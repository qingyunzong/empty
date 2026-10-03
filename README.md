# quota-freeze

Hierarchical quota freeze requests with a compressed positional index over
`policyText`. Node.js 22 standard library only, fully offline.

## Model

Each request: `{ id, parentId, amount, quota, policyText, state, version }`.

- A child may freeze only while its parent exists and is `active`, and only
  within the remaining freezable quota of **every** ancestor level.
- Each level's remaining balance = `quota - sum of active amounts in its subtree`.
- `expire` is a logical delete (excluded from queries and quota consumption,
  restorable via `restore`). `purge` physically removes expired requests and
  merges compressed index segments into one — unrecoverable, survives restart.
- Writes carry optimistic-concurrency versions; stale versions are rejected
  with `STALE_VERSION` and leave state unchanged.
- Every mutation returns per-level before/after balances, the occupancy
  chain, and a version certificate `{ version, hash }` (sha256 chain).

## Library

```js
import { Store } from './src/store.js';
const store = new Store('./data');
store.freeze({ id: 'root', amount: 10, quota: 100, policyText: 'alpha beta' });
store.freeze({ id: 'child', parentId: 'root', amount: 20, quota: 50 });
store.query('alpha beta');        // exact phrase -> ['root']
store.expire('child', 1);
store.restore('child', 2);
store.update('child', 3, { amount: 25 });
store.purge();
store.balance('root');
```

## CLI

```
node bin/quota.js freeze  --id ID [--parent ID] --amount N --quota N [--policy TEXT] [--dir DIR]
node bin/quota.js expire  --id ID --version N
node bin/quota.js restore --id ID --version N
node bin/quota.js update  --id ID --version N [--amount N] [--policy TEXT]
node bin/quota.js purge
node bin/quota.js query   --phrase TEXT
node bin/quota.js get|balance --id ID
node bin/quota.js list
```

All output is JSON on stdout; errors are JSON on stderr with exit code 1.

## Storage layout

- `<dir>/data.json` — requests, global version sequence, certificate head (atomic write).
- `<dir>/index/seg-NNNNNN.json` — compressed positional index segments
  (delta + varint encoded postings, base64). `purge` merges them into one.

## Tests

```
node --test
```
