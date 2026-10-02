# offline-sched

Offline scheduling change library and CLI. Node.js 22, standard library only,
tests via `node:test`.

## Model

State (`src/state.js`):

- `machines`: id -> `{ id, calendar: [[start, end], ...] }` (available windows)
- `orders`: id -> `{ id, priority, ops: [{ id, machine, duration, family, preds }] }`
- `setup`: machine -> fromFamily -> toFamily -> changeover time
- `schedule`: last committed schedule (or `null`)

## Scheduler

`computeSchedule(state, { budget })` (`src/schedule.js`) is exact: it enumerates
linear extensions of the precedence DAG with branch and bound, simulating each
with serial list scheduling over machine calendars (operations plus changeover
must fit inside one calendar window; one operation at a time per machine).

- Primary objective: total weighted completion time (priority x order completion).
- Tie-break 1: minimal total changeover time.
- Tie-break 2: lexicographically smallest work-order sequence (per-machine
  order-id lists, machines in sorted id order, concatenated).
- `budget` is a makespan deadline; exceeding it (or no feasible placement)
  throws `E_BUDGET`. Cyclic/dangling precedence throws `E_PRECEDENCE`.

## Change log

`src/log.js` keeps an append-only chunked delta log (`log.dat`). Each chunk is
one line: `<crc32-hex> <base64 payload>`; the payload is the canonical JSON of
a commit record `{ seq, type, target, ops, inverse, prevHash, hash }`. `hash`
chains each record to its predecessor (audit chain, SHA-256).

Every `snapshotEvery` commits a full snapshot is written to
`snapshots/<seq>.json` and `{ seq, offset, stateHash, chainHash }` is appended
to `snapshot.index`.

- Every commit computes inverse ops against the pre-commit state.
- `undo` appends a compensating record (`type: "undo"`) with the target's
  inverse ops; history is never erased.
- `redo` is only valid while the history tail is the matching undo record;
  otherwise `E_DIVERGED`.
- Recovery: a corrupt tail chunk is truncated (last transaction invisible,
  snapshots still open); corruption anywhere else, a broken audit chain, or a
  failed snapshot integrity check raises `E_CRC`.

## CLI

```
node bin/sched.js init <dir> [--snapshot-every N]
node bin/sched.js add-machine <dir> --id M1 --calendar '[[0,100]]'
node bin/sched.js add-order <dir> --id W1 --priority 2 --ops '[{"id":"a","machine":"M1","duration":5,"family":"A","preds":[]}]'
node bin/sched.js set-setup <dir> --machine M1 --from A --to B --time 4
node bin/sched.js remove-order <dir> --id W1
node bin/sched.js schedule <dir> [--budget N]
node bin/sched.js undo <dir> | redo <dir> | status <dir> | verify <dir>
```

Exit codes: `0` ok, `10` `E_BUDGET`, `11` `E_PRECEDENCE`, `12` `E_CRC`,
`13` `E_DIVERGED`, `1` anything else.

## Tests

```
node --test
```

- `test/schedule.test.js`: library result matches an independent brute-force
  enumeration of all permutations; precedence/load constraints; `E_BUDGET`,
  `E_PRECEDENCE`.
- `test/log.test.js`: 3 commits + 2 undos + 1 redo reproduce state, snapshot
  hash and audit chain exactly; tail-chunk corruption hides the last
  transaction while snapshots stay openable; other corruption yields `E_CRC`.
- `test/cli.test.js`: CLI end-to-end and exit codes.
