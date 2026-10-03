# Hierarchical Settlement Revocation

Offline settlement-revocation library and CLI. Node.js 22, standard library
only, tested with `node:test`.

## Model

Settlement groups form a tree. A child group reserves budget from its parent;
cancelling a group returns its reservation. Group states:

| State     | Meaning                                        |
| --------- | ---------------------------------------------- |
| OPEN      | active, may be prepared or cancelled           |
| PREPARED  | commit in flight (WAL PREPARE written)         |
| SETTLED   | terminally settled, can never be revoked       |
| CANCELLED | revoked, reservation returned to the parent    |
| PARTIAL   | revoked, but settled descendants were kept     |

Allowed transitions: `OPEN -> PREPARED -> SETTLED`, `PREPARED -> OPEN`
(crash rollback), `OPEN -> CANCELLED | PARTIAL` (cancel), `PARTIAL -> PARTIAL`.

Revoking a parent cascades only to descendants that are not independently
SETTLED. Settled descendants are kept and reported in `blocked` with a
reason; the parent ends `PARTIAL` (exit 0), not failed.

## WAL

Every commit is two-phase: a `PREPARE` record (subtree snapshot + budget
impact) is appended to `wal.log` and fsynced, then a `COMMIT` record. A crash
between PREPARE and COMMIT is rolled back to uncommitted on the next start.

## CLI

```sh
node cli.js --data DIR init --budget 1000 [--id root]
node cli.js --data DIR add --parent root --id g1 --amount 400
node cli.js --data DIR prepare g1
node cli.js --data DIR commit g1
node cli.js --data DIR cancel g1
node cli.js --data DIR get g1
node cli.js --data DIR crash --after-prepare g1   # simulated crash, exit 3
```

Success prints JSON on stdout (exit 0). Errors print
`{"error":{code,message}}` on stderr with a non-zero exit code.

## Tests

```sh
node --test
```
