# alarm-ack-mvcc

Offline, single-node alarm acknowledgment store with MVCC, snapshot isolation,
a `(deviceId, alarmTime, state)` predicate index, and per-transaction undo logs.
Node.js 22+, standard library only, tests via `node:test`.

## Library

```js
import { AlarmStore } from './src/store.js';

const store = new AlarmStore();
store.insertAlarm({ deviceId: 'dev-1', alarmTime: 10 }); // autocommit

const txn = store.begin();                 // snapshot taken here
const count = txn.ackWindow('dev-1', 0, 100, {
  by: 'alice', at: '2026-10-04T00:00:00Z', note: 'night shift',
});                                        // fixes the ack set at scan time
txn.commit();                              // or txn.rollback()
```

Semantics:

- **Snapshot isolation**: a txn reads the committed state as of `begin()`.
- **Ack set fixed at scan**: `ackWindow` materializes the matching unacked
  alarms and records `(by, at, note)` per alarm; re-acking returns `0` and
  never creates duplicate ack records. Empty windows are legal no-ops (`0`).
- **Phantom detection**: at commit, if a concurrent txn committed a new
  *unacked* alarm matching this txn's scanned `(deviceId, window)` predicate
  (or this txn inserted one matching a committed concurrent txn's predicate),
  the commit aborts with `E_PHANTOM` (first committer wins). Different devices
  and disjoint windows do not conflict.
- **Write-write conflict**: two txns acking the same alarm -> second committer
  gets `E_CONFLICT`.
- **Undo log**: rollback (and abort) replays the per-txn undo list, restoring
  every alarm's prior state and dropping pending ack records.

Error codes: `E_PHANTOM`, `E_CONFLICT`, `E_TXN_STATE`, `E_VALIDATION`.

## CLI

Offline JSON-in/JSON-out. Reads a command document from a file argument or stdin:

```sh
echo '{"ops":[
  {"op":"insert","deviceId":"d1","alarmTime":1},
  {"op":"begin","txn":"t"},
  {"op":"ack","txn":"t","deviceId":"d1","start":0,"end":10,"by":"alice","note":"batch"},
  {"op":"commit","txn":"t"},
  {"op":"list"},
  {"op":"records"}
]}' | node src/cli.js
node src/cli.js commands.json
```

Ops: `begin`, `insert` (optionally inside `txn`), `ack`, `commit`, `rollback`,
`list`, `records`. Output is `{"results":[...]}` with one entry per op;
failures are `{"ok":false,"error":{"code":...,"message":...}}`.

Exit codes: `0` all ops succeeded, `1` an op failed (e.g. `E_PHANTOM`),
`2` malformed input or usage error.

## Tests

```sh
node --test
```

- `test/acceptance.test.js` — acceptance criteria 1 & 2, rollback/undo, conflicts.
- `test/enumeration.test.js` — acceptance 3: exhaustive enumeration of
  2-transaction histories over <= 4 seeded alarms (7,860 interleavings),
  checked op-by-op against a naive array reference that re-checks predicates
  at commit time.
- `test/cli.test.js` — CLI JSON protocol and exit codes.
