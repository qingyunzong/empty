# settlement-ledger

Causal event ledger for settlement account membership changes. Node.js 22,
standard library only, tested with `node:test`.

## Model

Every mutation (`add-account`, `remove-account`, `transfer`, `pay`) is a causal
event carrying `deps` (the frontier it observed). Removing an account writes a
tombstone with an epoch; removal is rejected with `balance-not-zero` unless a
zeroing transfer is causally visible. A pay causally after a tombstone is
rejected with `account-removed`; a pay causally before it stays as auditable
history. Re-adding a name creates a fresh incarnation id and epoch, starting
from balance zero. A remove and a pay that do not observe each other are
reported as a `remove-pay` conflict.

## CLI

```
node src/cli.js add-account <name> [--state file]
node src/cli.js remove-account <name> [--state file]
node src/cli.js transfer <from> <to> <amount> [--state file]
node src/cli.js pay <account> <amount> [--state file]
node src/cli.js merge <file> [--state file]
node src/cli.js account <name> [--state file]
```

State defaults to `ledger.json` (or `$LEDGER_FILE`). All output is JSON;
errors are `{"error":"code"}` with exit code 1.

## Test

```
node --test --test-reporter spec
```
