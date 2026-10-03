# causal-ledger

Single-machine causal settlement ledger for Node.js 22 (standard library only,
tests via `node:test`). Multiple local replicas exchange settlement and
adjustment events as JSON files; merges are incremental and validated against
vector clocks and a hash chain.

## Model

Each event is `{ replica, type, paymentId, amount, clock, preds, hash }`:

- `type`: `settle` or `adjust`
- `clock`: vector clock (object of replica id -> counter)
- `preds`: hashes of the direct causal predecessors (the replica's frontier)
- `hash`: SHA-256 of the canonical JSON of all other fields

Merge rules (per event, unknown events only; known hashes are skipped):

- `unknown-predecessor` — a direct predecessor hash is not known
- `stale-clock` — the clock regresses below a predecessor, or the per-origin
  sequence does not strictly advance (replica rollback / fork)
- `bad-hash` / `invalid-event` — malformed or tampered events

Semantics per payment: causally ordered events apply in order (later amount
wins). Concurrent events with different amounts are recorded as a conflict and
never silently resolved; concurrent events with equal amounts are fine.

`cert` emits `{ frontier, entriesHash, balances }` only when every reference
is present and no conflict exists; otherwise it fails with `{"error":"conflict"}`.

## CLI

All input and output is JSON. Success prints to stdout; errors print
`{"error":"code"}` to stderr and exit with code 1.

```sh
node cli.js append <ledger.json> '{"replica":"A","type":"settle","paymentId":"p1","amount":100}'
node cli.js merge  <ledger.json> <events.json>   # accepts an array or {"events":[...]}
node cli.js dump   <ledger.json>                 # prints the event array
node cli.js cert   <ledger.json>                 # prints the finality certificate
```

## Tests

```sh
node --test --test-reporter spec
```

`test/ledger.test.js` enumerates all 8 partial orders of three messages across
two replicas (for both origin assignments and two amount variants) and checks
causality, conflicts, balances, frontier, and `entriesHash` against an
independent reference implementation that derives causality from predecessor
reachability rather than vector clocks. `test/cli.test.js` covers the three
acceptance scenarios end to end through the CLI.
