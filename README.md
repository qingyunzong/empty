# biobank-custody-chain

Append-only, hash-chained custody ledger for biological samples. Records
`receive` / `transfer` / `analyze` / `destroy` events, supports compliant
consent revocation via tombstones (history is never erased), Merkle inclusion
challenges with offline verification, and crash-safe snapshots. Node.js 22,
standard library only, tested with `node:test`.

## Storage layout (per data dir)

- `events.jsonl` — one canonical-JSON event per line, each carrying `seq`,
  `prevHash`, and `hash = sha256(canonical(event without hash))`.
- `manifest.json` — snapshot manifest `{seq, headHash, merkleRoot, eventCount}`,
  written via tmp-file + fsync + atomic rename + directory fsync.

## Library

```js
import { Chain, verifyEvents, annotateRestricted } from './lib/chain.js';
import { merkleProof, verifyProof } from './lib/merkle.js';
import { snapshot } from './lib/snapshot.js';

const chain = await Chain.open('./data');      // recovers from crashes on open
await chain.append({ type: 'receive', sampleId: 'S1', consentId: 'C1' });
await chain.append({ type: 'revoke', consentId: 'C1' });   // tombstone
chain.verify();                                // throws BROKEN_CHAIN w/ index
const proof = merkleProof(chain.leafHashes(), 0);
verifyProof(proof);                            // offline, no chain needed
await snapshot(chain);                         // atomic manifest
```

## CLI

```
node bin/custody.js [--dir ./data] <command>

event <receive|transfer|analyze|destroy> --sample S1 --consent C1 --data '{"k":"v"}'
revoke --consent C1 --reason "withdrew"     # tombstone; old events stay, flagged restricted
challenge [--index N]                       # Merkle proof for random or given leaf
verify [--proof proof.json]                 # chain integrity, or offline proof check
snapshot                                    # write manifest at defined point
list                                        # events with restricted flags
```

## Error codes

- `BROKEN_CHAIN` — hash/prevHash/seq integrity failure; `details.index` localizes it.
- `REVOKED_CONSENT` — new event depends on a revoked consent; append refused.
- `NO_PROOF` — challenge index outside the leaf set.

## Revocation semantics

`revoke` appends a tombstone event. Events already on the chain are retained
byte-for-byte (the chain stays verifiable) but are reported with
`restricted: true`; any *new* event referencing the revoked consent is rejected
with `REVOKED_CONSENT`.

## Crash recovery

On `Chain.open`: a torn trailing JSONL line is truncated; a hash-chain break
truncates to the last valid prefix; a manifest inconsistent with the chain
(dangling half-snapshot) is discarded; stale `*.tmp` files are removed. After
recovery the head is either the manifest's committed head or the last valid
old head — never a half-written state.

## Tests

```
node --test
```
