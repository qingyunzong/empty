# offline-settlement

Offline merchant end-of-day settlement library and CLI. Node.js 22, standard
library only, tests use `node:test`.

## Storage model

All state lives in a data directory as an append-only version log:

- `versions/<n>.json` — key/value writes committed by version `n` (immutable)
- `HEAD` — current version counter
- `lock/` — mkdir-based commit lock (first-committer-wins serialization)

A transaction (`store.begin()`) reads only its begin-time snapshot. `commit()`
fails with `E_CONFLICT` if any directly written key was committed by another
transaction after the snapshot. History is never overwritten; any past version
is readable via `store.readAt(key, v)` / `store.stateAt(v)` / `get --at V`.

## Domain keys

- `acct:<merchantId>` — `{ merchantId, balance }`
- `settle:<id>` — `{ id, merchantId, amount, status: OPEN|SETTLED|CANCELLED }`
- `reversal:<id>` — reversal record written when an OPEN slip is cancelled
- `entry:<id>:settle`, `entry:<id>:reversal:debit|credit` — ledger entries

Cancelling a non-OPEN slip fails with `E_STATE`; a stale-snapshot cancel that
loses to a concurrent commit fails with `E_CONFLICT`. Failed transactions
commit nothing, so no half-written reversal entries can appear.

## CLI

```sh
node cli.js --dir D tx '{"gets":["acct:m1"],"puts":{"settle:s1":{"id":"s1","merchantId":"m1","amount":100,"status":"OPEN"}},"cancel":"t1"}'
# success: {"version":n}   failure: {"error":"CODE"} (exit code 1)

node cli.js --dir D get settle:s1 --at 1   # value of one key at version 1
node cli.js --dir D get --at 2             # whole-state export at version 2
```

## Tests

```sh
node --test
```

Covers snapshot isolation, first-committer-wins conflicts, a reference-model
enumeration of all key/version visibility (≤20 key-versions), the three
acceptance scenarios (serial settle+cancel, three concurrent-cancel commit
orders, stale-snapshot cancel vs settle), and CLI process-level behaviour
including two CLI processes racing on one slip.
