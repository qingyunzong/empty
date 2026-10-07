# deadlock_diag

Diagnostic tool that rebuilds the wait-for graph from a lock-wait log and
reports the shortest deadlock cycle together with the source log events that
created each edge.

## Log format

One event per line; blank lines and lines starting with `#` are ignored.

```
<thread> wait    <lock> <shared|exclusive>
<thread> acquire <lock> <shared|exclusive>
<thread> release <lock>
```

## Model

- Threads may hold any number of locks; locks may be shared.
- An exclusive wait is blocked by **every** holder of the lock; a shared wait
  is blocked only by **exclusive** holders. A holder may be the waiter itself
  (e.g. a shared → exclusive upgrade against its own shared hold), which
  yields a 1-thread cycle.
- A thread waits on at most one request at a time; a new `wait` supersedes an
  earlier still-ungranted one, and a matching `acquire` clears it.
- **Incomplete calls are never guessed as granted**: a `wait` without a
  matching `acquire` keeps the thread waiting but confers no hold, so it
  creates outgoing edges only — never incoming ones.
- After **every** event the full wait-for graph is rebuilt from the complete
  lock state (point-in-time full-graph model) and checked for cycles; nothing
  is inferred from incremental deltas.

## Usage

```
deadlock_diag [--all] <logfile|->
```

- Default: prints the first moment a deadlock exists, the shortest wait-for
  cycle at that moment, and the wait/holder source events behind each edge.
- `--all`: prints the shortest cycle at every deadlocked moment.
- Exit status: `0` no deadlock, `1` deadlock found, `2` usage/parse error.

## Build & test

```
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

Tests: `test_model` (unit checks of parsing, blocking rules, incomplete
calls, multi-lock holders, shortest-cycle selection, upgrade self-deadlock)
plus CLI tests driven by `tests/run_expect.cmake` over `tests/logs/*.log`.
