# offline-planner

Offline injection-molding shop scheduler. Node.js 22, standard library only,
`node:test` for tests, single machine, fully offline.

## Model

JSONL inputs (one object per line):

- `machines.jsonl`  `{"id":"K1","rate":10}` — units per minute
- `molds.jsonl`     `{"id":"M1","machine":"K1"}` — a mold is bound to one machine
- `operators.jsonl` `{"id":"P1"}`
- `setups.jsonl`    `{"from":"M1","to":"M2","minutes":5}` — changeover matrix, `"*"` wildcard allowed
- `orders.jsonl`    `{"id":"O1","mold":"M1","operator":"P1","qty":100,"due":1000}`

Machine, mold and operator are mutually-exclusive resources: a job occupies all
three for `[start, end]`; conflicts are resolved by ordering, never silently
overwritten. Unknown references are **input errors** (exit 2), never treated as
infeasibility.

## Scheduling

- n <= 9: exhaustive permutation search (provably optimal).
- n > 9: deterministic best-insertion heuristic.
- Ties break deterministically: earliest makespan, then fewest changeover
  minutes, then lexicographic order-id sequence.
- Due dates are hard constraints; if unschedulable the CLI exits 3 with a
  minimal (irreducible) conflict set of order ids.

## Causal log, undo, certificates

Every plan operation (`load`, `insert`) is appended to `data/log.jsonl` with a
Lamport clock stamp, causal parents and a SHA-256 hash chain. `undo --to N`
moves the head pointer to any operation point (backwards = undo, forwards =
restore) and emits a certificate under `data/certs/` binding the promised due
dates (`commitmentsHash`) at that point. Concurrent duplicate inserts keep the
causally prior op and emit an `insert-conflict` certificate. `verify` replays
the log, re-checks all hashes and certificates, and compares the replayed plan
digest with the committed one.

Commits are crash-safe: `plan.tmp` -> fsync -> rename -> fsync(dir). A leftover
`plan.tmp` or an appended-but-uncommitted log op after a crash is discarded on
restart — no half commits.

## CLI

```
node cli.js plan --orders orders.jsonl --molds molds.jsonl --machines machines.jsonl \
     [--setups setups.jsonl] [--operators operators.jsonl] [--dir data] [--node NAME]
node cli.js plan --insert '{"id":"O9","mold":"M1","operator":"P1","qty":20,"due":1000}' [--dir data]
node cli.js undo --to N [--dir data]
node cli.js verify [--dir data]
```

Exit codes: `0` ok · `1` internal/corrupt/verify-failed · `2` invalid input
(stderr JSON `{"code","at"}`) · `3` infeasible (stderr JSON
`{"code":"E_INFEASIBLE","conflict":[...]}`) · `4` concurrent insert rejected
(certificate written).

## Test

```
npm test   # == node --test
```
