# offline-capacity-planner

Offline production planning library + single-machine CLI. Node.js 22, standard
library only (`node:test` for tests).

- 15-minute slots; each (workcenter, slot) has an integer capacity.
- Work orders can be inserted, adjusted and cancelled inside transactions.
- MVCC with snapshot isolation: a transaction reads at its begin snapshot.
- Predicate secondary index organized by `(workcenter, start, end)`
  (`src/slotindex.js`) tracks committed per-slot occupancy.
- At commit, every time-range predicate the transaction read is re-validated
  against the latest committed state. Two transactions that both saw remaining
  capacity cannot oversell, even when writing different orders:
  the loser gets `E_SNAPSHOT`; insufficient capacity gives `E_CAPACITY`.
  Exactly-full capacity is allowed; one unit over is rejected.
- Commit certificate: transaction id, commit timestamp and the hash of every
  validated predicate range.

## CLI

```
node cli.js plan.json        # or: cat plan.json | node cli.js
```

Input is a JSON array of commands (or `{ "commands": [...] }`); output is a
JSON array of per-command results. Times may be integer slot indices or
15-minute-aligned ISO timestamps.

Commands: `set_capacity`, `begin`, `read`, `insert`, `adjust`, `cancel`,
`commit`, `abort`. See `test/acceptance.test.js` for examples.

## Test

```
node --test
```
