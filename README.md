# offline-planner

Offline-capable production scheduler for a packaging plant that must survive
power loss: after a restart the system recovers to exactly the last committed
transaction. Node.js 22, standard library only, fully offline.

## Layout

- `src/lexer.js` — tokenizer
- `src/parser.js` — recursive-descent statements + Pratt expression parser
- `src/typecheck.js` — static types: `instant`, `duration`, `line`, `int`, `bool`
- `src/bytecode.js` — constraint compiler to stack-machine bytecode + VM
- `src/model.js` — calendars, maintenance, incremental constraint-checked scheduler
- `src/txn.js` — transaction manager (add-job / move-job / savepoint / rollback / commit)
- `src/interp.js` — interpreter: templates with lexical scope, execution
- `src/persist.js` — WAL / state / checkpoint persistence + recovery
- `src/cli.js`, `bin/plan.js` — `plan` CLI
- `test/` — node:test suites; `testlib/` — CLI runner + exhaustive reference scheduler

## DSL

```
line L1, L2;
calendar main { shift mon..fri 08:00-16:00; }
maintenance L1 @2026-01-06T10:00 for 2h;

template batch(n: name, l: line, d: duration, p: int) {
  job n { line: l; duration: d; priority: p; }
}

job J1 { line: L1; duration: 3h; priority: 2; after: J0; }
batch(J2, L2, 1h, 1);

constraint overlap(L1) <= 1 and total(L2) <= 8h;

add-job J3 { line: L1; duration: 1h; priority: 3; };
move-job J3 to L2;
savepoint s1;
rollback s1;
commit;
```

- Literals: ints, durations (`30m`, `2h`, `1d`), instants (`@2026-10-05T08:00`, UTC).
- Expressions use Pratt parsing with precedence
  `or < and < ==/!= < </<=/>/>= < +/- < *//`, plus unary `-`/`not`.
- Static typing rejects e.g. `1 + 2h`, `1h < @2026-01-05T08:00`, `overlap(1)`.
- `overlap(L)` (max concurrent jobs on a line) and `total(L)` (sum of
  durations) are the resource primitives; constraints compile to bytecode
  (`OVERLAP`/`TOTAL`/arithmetic/logic ops) and are evaluated incrementally —
  only programs touching the changed line are re-run per candidate slot.
- Templates are lexically scoped: the body sees parameters (which shadow
  outer names) plus only the names declared before the template.
- Scheduling horizon: 12 weeks from Monday 2026-01-05 (UTC); a job must fit
  inside one shift window and outside maintenance. Higher priority schedules
  first; tied priorities are ordered by job name (deterministic).

## Transactions

`add-job` / `move-job` mutate the model inside an implicit transaction.
`savepoint <name>` nests arbitrarily; `rollback <name>` undoes everything at
and after that point, removes later savepoints, and keeps the target and all
earlier savepoints valid; `rollback` without a name targets the most recent
savepoint; `commit` finalizes all active transaction state. A script without
`commit` is simulated (schedule printed) but never persisted.

## Persistence & recovery

```
<dir>/wal/000001.log        one JSON record per committed script, sha256 checksummed
<dir>/state/state.json      materialized committed model + checksum (tmp+rename)
<dir>/checkpoint/checkpoint.json  {seq, stateChecksum} + checksum
```

Commit order is WAL → state → checkpoint, giving three crash points:

1. **Before WAL commit** — a torn/uncommitted tail record is ignored.
2. **After WAL, before state** — committed WAL is replayed and state is
   rebuilt idempotently.
3. **After state, before checkpoint** — the stale checkpoint is detected and
   rewritten.

Recovery replays committed WAL records, verifies checksums, and repairs
state/checkpoint so the store equals the last commit. A checksum failure in
the WAL tail is treated as an uncommitted record and ignored; corruption
followed by more records is fatal (`RECOVERY_ERROR`).

## CLI

```
plan init <dir>                create wal/state/checkpoint
plan apply <dir> <script.plan> run a script; persist iff it commits and is feasible
plan recover <dir>             replay WAL, repair state/checkpoint
plan export <dir>              print committed schedule as JSON
```

Exit codes (observed):

| code | meaning                                             |
|------|-----------------------------------------------------|
| 0    | success                                             |
| 1    | `ERROR:` usage, lex/parse/type, txn, or I/O failure |
| 2    | domain infeasible, prints `INFEASIBLE`              |
| 3    | corrupt files, prints `RECOVERY_ERROR:`             |

## Tests

```
node --test
```

Latest run: **27 passed, 0 failed** across 5 files
(`dsl` 7, `txn` 5, `schedule` 4, `recovery` 9, `enumeration` 2).

Coverage of the acceptance criteria:

1. Feasible plan with tied priorities → `test/schedule.test.js`.
2. Nested savepoint rollback → `test/txn.test.js`.
3. All three crash-point fixtures recover to the last commit → `test/recovery.test.js`.
4. ≤7-job instances (40 seeded random + handwritten edge cases) cross-checked
   against an exhaustive backtracking reference (`testlib/reference.js`) →
   `test/enumeration.test.js`.
5. Checksum corruption: mid-WAL → `RECOVERY_ERROR`; corrupt tail ignored;
   corrupt state/checkpoint rebuilt → `test/recovery.test.js`.
