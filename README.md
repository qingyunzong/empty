# tombstone-ledger

Causal tombstone ledger for trade cancel/restore, Node.js 22, standard library
only. Tests use `node:test`.

## Model

Every event is a node in a Merkle-DAG:

```json
{
  "id": "unique event id",
  "type": "trade | cancel | restore",
  "tradeId": "business trade id",
  "prev": ["causal parent hashes (current heads)"],
  "observes": "cancel -> trade hash it cancels; restore -> cancel hash it observes",
  "hash": "sha256 over canonical {id,type,tradeId,prev,observes}"
}
```

State is derived per `tradeId` from the event set (causal tombstone set):

- a **cancel** raises a tombstone; concurrent cancels of one trade collapse
  into a single tombstone, and re-arriving duplicate events are idempotent;
- a **restore** clears the tombstones of exactly the cancels in its causal
  past, so a stale replayed cancel can never re-cancel a restored trade;
- a cancel and a restore that do not observe each other (concurrent) are a
  **conflict**;
- a restore that observes no cancel is rejected with `restore-without-cancel`.

`status` is `conflict` if any concurrent cancel/restore pair exists, else
`cancelled` if a live tombstone remains, else `active`.

## CLI

State lives in `$LEDGER_FILE` (default `./ledger.json`). All output is a
single JSON line; errors are `{"error":"code"}` with exit code 1.

```sh
node cli.js trade <tradeId>    # -> event JSON
node cli.js cancel <tradeId>   # -> event JSON (error: unknown-trade)
node cli.js restore <tradeId>  # -> event JSON (error: restore-without-cancel)
node cli.js merge <file>       # file: [event,...] or {"events":[...]} -> {"added":n,"duplicates":n}
node cli.js get <tradeId>      # -> {"tradeId","status","tombstone","cancels","restores"}
```

Merges are atomic: a file that fails validation (bad hash, unknown observed
trade, restore without cancel, duplicate trade id) leaves the ledger untouched.

## Library

`src/ledger.js` exports `Ledger`, `LedgerError` (with `.code`) and
`hashEvent`. `Ledger#merge` accepts events in any causal order within a batch
and validates referential integrity over the union.

## Tests

```sh
node --test --test-reporter spec
```

`test/ledger.test.js` derives the same states with an independent set-based
reference model (fixpoint ancestry + set algebra), enumerates all topological
orders of several trade/cancel/restore DAGs, and checks convergence of
tombstones and status. `test/cli.test.js` covers the CLI acceptance flows.
