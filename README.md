# dpor

Dynamic partial-order reduction (DPOR) explorer for small shared-memory
concurrent programs (up to 4 threads, up to 8 atomic operations per
thread), written in pure Python 3.11+ standard library.

## Usage

```
python -m dpor explore program.json --max-schedules 5000 --out report.json
```

The report (also printed to stdout) contains:

- `status`: `OK` | `VIOLATION` | `E_LOCK` | `BOUND_REACHED`
- `schedules`: number of terminated schedules explored
- `explored`: number of states visited
- `witness`: a concrete schedule (list of `{"thread", "op"}`) for
  `VIOLATION` / `E_LOCK`, else `null`
- `errors`: details of `E_LOCK` failures

An invalid program (bad JSON, unknown op, more than 4 threads or 8 ops
per thread, missing fields, ...) exits with code **2**.

## Program format

```json
{
  "threads": [
    {"name": "T1", "ops": [{"op": "write", "addr": "x", "value": 1}]},
    {"name": "T2", "ops": [{"op": "assert", "addr": "x", "eq": 0}]}
  ]
}
```

Operations: `read`/`write` (with `addr`, `value`), `lock`/`unlock`
(with `lock`), `assert` (with `addr`, `eq`; fails when
`memory[addr] != eq`, memory defaults to 0).

## Semantics

- **Dependency**: two operations of different threads are dependent iff
  they access the same address and at least one is a write (`assert`
  counts as a read), or they contend on the same lock.
- **Partial-order reduction**: stateless DPOR (Flanagan-Godefroid style
  backtrack sets) combined with sleep sets.  Interleavings that differ
  only by swapping independent operations (the same Mazurkiewicz /
  happens-before equivalence class) are explored exactly once; every
  equivalence class is covered.  Lock/unlock transitions conservatively
  race with all co-enabled threads, since they alter enabledness.
- **Locks** are re-entrant for the owning thread.  `unlock` of a lock
  the thread does not hold is an `E_LOCK` error and terminates that
  schedule (other schedules are still explored).
- **assert** failure stops exploration and reports `VIOLATION` with a
  concrete witness schedule.
- Reaching `--max-schedules` stops exploration and reports
  `BOUND_REACHED` (never `OK`).

## Tests

```
python -m unittest discover -s tests -v
```

The suite checks the acceptance criteria (data-race interleaving count
vs. manual enumeration, independent-read swapping, `E_LOCK`,
`BOUND_REACHED`), compares DPOR against brute-force enumeration of all
Mazurkiewicz equivalence classes on hand-written and 150 randomly
generated programs, and exercises the CLI end to end (including exit
code 2 for invalid programs).
