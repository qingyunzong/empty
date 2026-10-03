# offline-planner

Offline production planning library + single-machine offline CLI. Node.js 22,
standard library only, tests via `node:test`.

Work orders are scheduled onto capacity-limited workcenters. Each workcenter
has an integer capacity per 15-minute slot (`[start, end)` in slot units).
Supports insert / adjust / cancel, MVCC with snapshot isolation, and a
predicate secondary index organized by `(workcenter, start, end)`.

## Concurrency model

- `db.begin()` opens a transaction at the current commit sequence (snapshot).
- `tx.readOccupancy` / `tx.readRemaining` read the snapshot and register the
  `(workcenter, start, end)` predicate.
- `tx.commit()` first re-validates every read predicate against the **latest
  committed state**; a mismatch aborts with `E_SNAPSHOT` — this prevents two
  transactions that both saw remaining capacity from over-committing, even
  though they write different orders. Then per-slot capacity is checked:
  load equal to capacity is allowed, exceeding by 1 aborts with `E_CAPACITY`.
- A successful commit returns a certificate: `txId`, `commitTimestamp`, and
  SHA-256 hashes of all validated predicates.

## CLI

```sh
node bin/cli.js plan.json   # or pipe JSON on stdin
```

Input: `{"commands": [...]}` with ops `setCapacity`, `begin`, `read`,
`readRemaining`, `insert`, `adjust`, `cancel`, `commit`, `abort`.
Output: `{"results": [...]}` — commits yield a certificate or
`{ok: false, error: "E_CAPACITY" | "E_SNAPSHOT"}`.

## Tests

```sh
node --test
```
