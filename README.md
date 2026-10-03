# alarm-ack-mvcc

Offline batch alarm acknowledgement with MVCC, snapshot isolation, a
(deviceId, alarmTime, state) predicate index and an undo log. Node.js 22,
standard library only, tested with `node:test`.

## Layout

- `src/store.js` — MVCC store: version chains, snapshot isolation, predicate
  index, undo log, phantom detection (`E_PHANTOM`).
- `src/refstore.js` — naive reference implementation (plain arrays, predicate
  re-check at commit) used as the executable spec by the enumeration test.
- `src/cli.js` — offline JSONL CLI (also exports `runSession` for tests).
- `test/` — `node:test` suites.

## Semantics

- `txn.ackWindow({deviceId, from, to, by, at, note})` acknowledges every
  unacked alarm of `deviceId` with `from <= alarmTime <= to`, as determined by
  the transaction's begin snapshot, and records one ack record per alarm
  (alarmId, deviceId, alarmTime, by, at, note). Empty window = legal no-op,
  returns `count: 0`.
- At commit, every scanned window is re-checked against the latest committed
  state. A concurrent committed insert/ack by another transaction inside a
  scanned window aborts the committer with `E_PHANTOM`; the aborted
  transaction is fully rolled back (undo log restores prior alarm states, no
  ack records survive). Own writes never count as phantoms. Different devices
  and disjoint windows never conflict.
- Rollback replays the undo log in reverse: every alarm returns to its prior
  state and no ack records remain.

## CLI

```
node src/cli.js <stateFile> < commands.jsonl
```

One JSON command per line on stdin, one JSON result per line on stdout.
State persists in `<stateFile>` between runs.

```
{"op":"insert","id":"a1","deviceId":"d1","alarmTime":10,"state":"unacked"}
{"op":"confirm","deviceId":"d1","from":0,"to":20,"by":"op1","at":100,"note":"batch"}
{"op":"begin","tx":"t1"} / {"op":"commit","tx":"t1"} / {"op":"rollback","tx":"t1"}
{"op":"insert","tx":"t1",...} / {"op":"confirm","tx":"t1",...}   (inside a named txn)
{"op":"dump"}
```

Exit codes: `0` all commands ok; `1` domain error (E_PHANTOM, E_DUP_ID,
E_TXN_CLOSED, E_TXN_EXISTS, E_UNKNOWN_TXN); `2` usage/structural error
(bad args, invalid JSON, unknown op, invalid fields).

## Tests

```
node --test
```

See `RESULTS.md` for the recorded run.
