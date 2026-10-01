# dpor

Dynamic partial-order reduction (DPOR) explorer for small shared-memory
concurrent programs, plus a CLI. Python 3.11+, standard library only.

## Usage

    python -m dpor explore program.json --max-schedules 5000 --out report.json

The report is also printed to stdout. Exit code is 0 for every exploration
outcome and 2 when the program description is invalid.

## Program format

    {
      "threads": [
        [ {"op": "write", "addr": "x", "value": 1},
          {"op": "read",  "addr": "x", "dst": "r0"},
          {"op": "assert", "var": "r0", "equals": 1} ],
        [ {"op": "lock",   "lock": "L"},
          {"op": "unlock", "lock": "L"} ]
      ]
    }

- 1-4 threads, at most 8 atomic ops per thread.
- `read addr [dst]`: load shared address into a thread-local variable
  (default `_`). Shared memory and locals start at 0.
- `write addr value`: store an integer.
- `lock` / `unlock lock`: reentrant mutex. Re-locking by the holder is
  allowed; `unlock` of a lock not held by the current thread aborts the
  schedule with `E_LOCK`.
- `assert addr|var equals`: fails the schedule with `VIOLATION` when the
  observed value differs.

## Dependency and reduction

Two ops are dependent iff they access the same address with at least one
write, or they compete for the same lock. The explorer is a stateless
DPOR (Flanagan-Godefroid style): backtrack sets per schedule prefix are
updated from the happens-before relation of the current trace, so
swapping independent operations never produces a new schedule. Completed
executions are fingerprinted by their Mazurkiewicz (dependency-order)
signature, guaranteeing each non-equivalent interleaving is counted once.

## Report

    {
      "status": "OK" | "VIOLATION" | "E_LOCK" | "BOUND_REACHED",
      "schedules": <number of non-equivalent schedules explored>,
      "explored":  <total executions run, incl. duplicates/error stops>,
      "witness":   <failing schedule as [{thread, pc, op}, ...] or null>
    }

`BOUND_REACHED` is reported when the schedule bound is hit; it is never
reported as `OK`.

## Tests

    python -m unittest discover -s tests -v
