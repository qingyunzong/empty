# offline-scheduler

Offline scheduling change library and CLI. Node.js 22, standard library only,
tests via `node:test`.

## Model

State (all times in minutes):

- `machines`: id -> availability `calendar` (sorted, non-overlapping `[start, end)` windows)
- `orders`: id -> `{ product, priority, ops: [{ machine, duration }] }`; operations of an
  order run strictly in order (intra-order precedence)
- `changeovers`: per-machine setup matrix `from>to -> minutes`
- `deps`: explicit cross-order precedences (`opId -> [predecessor opId]`, `opId = ORDER:INDEX`)
- `budget`: upper bound for the primary objective

## Scheduling

`solveSchedule` (src/scheduler.js) is an exact branch-and-bound over topological
orders of the precedence DAG. Feasibility respects operation precedence and
machine load (no overlap, operations must fit inside calendar windows).
Objective lexicographic:

1. minimize total weighted completion time `sum(priority * completion)`
2. minimize total changeover time
3. lexicographically smallest canonical order sequence
   (per-machine order lists, machines sorted by id, concatenated)

Errors: `E_BUDGET` (best objective over budget), `E_PRECEDENCE` (dependency
cycle), `E_CRC` (journal/snapshot corruption).

## Persistence

- `journal.log`: append-only chunked delta log. Chunk = `magic(4) | len(4) |
  crc32(4) | payload(JSON)`. Each payload is one commit record with its delta
  ops, pre-computed inverse ops, and a hash-chain link (`hash = sha256(parent +
  canonical(record))`).
- `snapshots/`: periodic full-state snapshots (`snap-*.json`) plus
  `index.json` recording `{ seq, logOffset, file, stateHash }` for each
  snapshot. On open, the newest snapshot consistent with the surviving journal
  records is selected; later chunks are replayed on top.
- Corruption handling: a corrupt/torn tail chunk is truncated (the last
  transaction becomes invisible, snapshots still open); corruption followed by
  further valid chunks, or any corruption under `verify`/`strict`, raises
  `E_CRC`.

## Undo / redo

Every commit stores its inverse. `undo` appends a compensation record applying
the inverse of the effective tip — history is never erased. `redo` re-applies
the undone commit and is only valid while the history tail is the undo record
(no diverging commit since); otherwise `E_DIVERGED`.

## CLI

```
sched init <dir>
sched machine add <dir> <id> --calendar "0-480,1440-1920"
sched order add <dir> <id> --product P1 --priority 3 --ops "M1:60,M2:30"
sched changeover set <dir> <machine> <from> <to> <minutes>
sched dep add <dir> <opId> <beforeOpId>
sched budget set <dir> <N|null>
sched schedule|undo|redo|snapshot|status|verify <dir>
```

Exit codes: `0` ok, `2` usage, `10` E_BUDGET, `11` E_PRECEDENCE, `12` E_CRC,
`13` E_DIVERGED, `14` E_STATE, `1` other I/O.

## Tests

```
node --test
```

- `test/scheduler.test.js`: solver vs. brute-force reference enumerating all
  operation permutations
- `test/history.test.js`: 3 commits + 2 undos + 1 redo — state, snapshot hash
  and audit chain identical after reopen
- `test/corruption.test.js`: corrupt tail hides last transaction, snapshot
  still opens; mid-log corruption -> E_CRC
- `test/errors.test.js`: E_BUDGET / E_PRECEDENCE semantics
- `test/cli.test.js`: CLI behaviour and exit codes (in-process)
