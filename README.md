# credit-hold-ledger

Event-sourced cardholder credit ledger (Node.js 22, standard library only).

- **Domain**: authorize (freeze) / release (partial unfreeze) / reverse (void) /
  capture (settlement debit), plus authorization split/merge.
- **Dependency graph** (`src/graph.js`): authorization holds -> account held ->
  account available -> merchant settlement. Mutations invalidate source nodes;
  propagation refreshes dependents differentially. Split/merge rewires the
  topology dynamically; reversal invalidates an authorization so its id can be
  reused.
- **Event sourcing**: every applied command appends a journal record with
  deltas and a human-readable reason. `Ledger.replay(events, k)` deterministically
  rebuilds the state after any prefix `k`.
- **Concurrency**: `applyBatch` totally orders concurrent captures on the same
  authorization by arrival `seq`, ties broken by `requestId`.
- **Persistence** (`src/store.js`): append-only JSONL log, fsync per append;
  recovery truncates a torn tail left by a crash before fsync.

## Invariants

- A hold never exceeds available credit; excess fails with `INSUFFICIENT` and
  leaves no partial state.
- Release/capture amounts may not exceed the remaining frozen amount
  (`EXCEEDS_HELD`).

## CLI

```
node bin/cli.js [--commands <file>|-] [--log <file>] [--trace]
```

Reads JSONL commands (stdin by default), prints the account snapshot as JSON
to stdout; `--trace` also prints one JSON line per applied command explaining
the change. `--log` restores prior state and appends new commands. Errors go
to stderr with exit code 4.

### Command ops

`open_account` `{accountId, creditLimit}` ·
`authorize` `{accountId, authId, amount, requestId?}` ·
`release` `{accountId, authId, amount}` ·
`reverse` `{accountId, authId}` ·
`capture` `{accountId, authId, amount, merchantId?, seq?, requestId?}` ·
`split` `{accountId, authId, into: [{authId, amount}, ...]}` ·
`merge` `{accountId, from: [authId, ...], into}`

## Tests

```
node --test
```
