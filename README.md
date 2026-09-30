# treesync

One-way synchronization of small file trees with journaled, resumable batches.
Python 3.11+ standard library only.

## Usage

```
python -m treesync sync SRC DST [--state STATE]
```

- `--state` defaults to `DST/.treesync_state`.
- The plan and result are printed to stdout as JSON; errors go to stderr.
- Exit codes: `0` ok, `2` fatal error, `4` conflict (foreign entries in DST).

## Semantics

- File fingerprint = sha256 + size + mtime_ns. Identical content
  (sha256+size) that only changed path is applied as a rename inside DST,
  never as delete+create.
- Ops are executed in batches of at most 64. Each batch is written to
  `<state>.journal` before execution; every op is fsynced and marked done
  individually. On startup an unfinished journal is resumed; all ops are
  idempotent.
- Copies write `<name>.treesync.tmp` first, fsync, then rename into place.
  Leftover temp files are cleaned on startup.
- DST entries missing from SRC are deleted only if the previous state proves
  they came from SRC; otherwise the run aborts with exit code 4 and touches
  nothing.
- An empty source tree is legal: DST is emptied of tracked entries while
  `.treesync_state` (and the journal) are preserved.

## Tests

```
python -m unittest discover -s tests -v
```

Crash-injection hooks used by the tests (environment variables):
`TREESYNC_TEST_CRASH_IN_COPY=1` (SIGKILL mid-copy, leaves a half-written
temp) and `TREESYNC_TEST_KILL_AFTER_OP=N` (SIGKILL after op N, before the
journal mark).
