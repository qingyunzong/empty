# taskq — crash-safe persistent task queue

A tiny CLI task queue with a single, precisely defined commit point and
deterministic crash recovery. Python 3.11+, standard library only.

## Usage

```
python -m taskq run script.json --db queue.json --out done.json
python -m taskq recover --db queue.json
```

`script.json`:

```json
{"actions": [
  {"op": "enqueue", "task": "t1", "at": "2026-10-01T00:00:00Z"},
  {"op": "run", "task": "t1", "dur": 0.5},
  {"op": "crash", "stage": "after_tmp_before_rename"}
]}
```

## Persistence protocol

The db (`queue.json`) is only ever written via atomic replacement:

1. serialize state to `queue.json.tmp`
2. `fsync(queue.json.tmp)`
3. `os.replace(queue.json.tmp, queue.json)` — **the commit point is the
   moment `rename` returns**
4. `fsync` the containing directory

- `enqueue`: tmp → fsync → rename; the task is visible only after a
  successful rename.
- `run`: when the task finishes, the done record is appended to the
  in-memory done log first, then the db commit (task removed from
  `pending`, added to `done`) is performed; the commit point is the rename.

## Crash points and recovery

The `crash` action simulates a crash at one of three stages and exits with
code 3 immediately; no subsequent action is executed:

| stage | effect before exit 3 |
|---|---|
| `before_tmp` | nothing written |
| `after_tmp_before_rename` | `queue.json.tmp` written + fsynced, no rename |
| `after_rename` | tmp written, rename completed |

`recover` rule:

- `queue.json.tmp` exists ⇒ the rename never completed ⇒ the tmp is
  uncommitted garbage: **discard the tmp, keep `queue.json`**.
- rename completed ⇒ `queue.json` is the committed state: **keep it**
  (the tmp no longer exists by definition of `rename`).
- Invariant enforced: no task id may be both `done` and `pending`.
- Recovery is idempotent: running it twice yields the same state.

## Exit codes

- `0` — success
- `2` — validation error: bad JSON, unknown op, negative `dur`, duplicate
  enqueue id (conflict; the db is left untouched), run of a non-pending task
- `3` — simulated crash

## Output

`run` prints a JSON report of every action's result plus final
`pending`/`done`, and writes the done records to `--out`. `recover` prints
the recovered `pending`/`done` and whether a stale tmp was discarded.

## Tests

```
python -m unittest discover -s tests -v
```

Covers: (A) crash `after_tmp_before_rename` → recovery without duplicates;
(B) crash `after_rename` → task `done` and not `pending`; (C) duplicate id →
exit 2 with db unchanged; (D) enumeration of every crash point (position ×
stage) for scripts of ≤ 8 actions checked against an independent
file-state-machine reference model; (E) recovery idempotence.

## Recorded real results (this machine, Python 3.14.4)

Test suite:

```
$ python -m unittest discover -s tests -v
...
Ran 13 tests in 52.483s
OK
```

Crash CLI runs with script
`[enqueue t1, run t1 (dur 0), crash <stage>, enqueue t2]`
(`enqueue t2` is never executed in any case):

| stage | run exit | run stderr | tmp after crash | recover exit | recovered state | sha256(queue.json) after recover |
|---|---|---|---|---|---|---|
| `before_tmp` | 3 | `crash simulated` | no | 0 | `pending=[], done=[t1]` | `3eaad629…db3f2f7` |
| `after_tmp_before_rename` | 3 | `crash simulated` | yes (discarded) | 0 | `pending=[], done=[t1]` | `3eaad629…db3f2f7` |
| `after_rename` | 3 | `crash simulated` | no | 0 | `pending=[], done=[t1]` | `3eaad629…db3f2f7` |

Full hash: `3eaad629aeb6f37ef9ac804ce6c2298ed77b83ce0f3caa1af9dd65dc1db3f2f7`
— identical for all three stages, and identical again after a second
`recover` (exit 0), proving recovery idempotence.

Duplicate-id conflict:

```
$ python -m taskq run dup.json --db queue.json --out done.json
error: action[1]: duplicate enqueue id 't1'   # stderr, exit code 2
# queue.json not created/modified, no queue.json.tmp left behind
```
