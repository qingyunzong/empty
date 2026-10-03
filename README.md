# offline-settlement

Offline merchant day-end settlement library + CLI. Node.js 22, standard
library only, tested with `node:test`.

## Storage model

All state lives under a data directory as append-only version files
(`versions/NNNNNN.json`). A transaction begins with a snapshot version and
reads only that snapshot. Commit is first-committer-wins: if any key the
transaction wrote was committed by someone else after its snapshot, the
commit fails with `E_CONFLICT`. History is never overwritten — cancelling
a slip writes a reversal record and debit/credit reversal entries as a new
version.

Slip lifecycle: `OPEN` -> `SETTLED`, or `OPEN` -> `CANCELLED` (via reversal).

## CLI

```sh
# Run a transaction described as JSON
node cli.js --dir D tx '{"gets":["m1"],"puts":{"settle:s1":{"id":"s1","merchant":"m1","amount":100,"status":"OPEN"}},"cancel":"t1"}'
# -> {"version":3}            (exit 0)
# -> {"error":"E_CONFLICT"}   (exit non-zero)

# Read a key at a historical version (default: latest)
node cli.js --dir D get settle:s1 --at 1

# Dump full state at a version
node cli.js --dir D get --at 1
```

Error codes: `E_CONFLICT`, `E_NOT_FOUND`, `E_INVALID_STATE`,
`E_BAD_REQUEST`, `E_USAGE`.

## Test

```sh
node --test
```
