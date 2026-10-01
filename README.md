# ilog

Persistent set of half-open integer intervals `[lo, hi)` stored in a single
JSON file, with a crash-safe commit protocol. Python 3.11+ stdlib only.

## CLI

```
python -m ilog.cli [--file PATH] OP [OP ...]
```

Operations run left to right; mutations stay in memory until `commit`:

- `add LO HI` / `remove LO HI` — mutate the in-memory set
- `compact` — normalize (merge adjacent/overlapping intervals)
- `commit` — persist via the crash-safe commit flow
- `show` — print current state as JSON

Exit code `2` on errors (`code=IO` or `code=BAD_INTERVAL`).

## Commit protocol

1. Serialize new state to `<path>.tmp`, fsync.
2. Write commit marker `<path>.commit` (sha256 of tmp), fsync.
3. Atomically `os.replace(tmp, path)`, fsync the directory.
4. Remove the marker.

Fault points (injectable via `ilog.set_fault_hook`): `after_tmp_write`,
`after_marker`, `after_replace`.

## Recovery on open

- No marker → load main file, discard leftover tmp (`recovered="clean"`).
- Marker + complete tmp → adopt the tmp state, clear marker
  (`recovered="committed"`).
- Marker + tmp missing but main matches the marker digest → replace already
  happened; clear marker (`recovered="clean"`).
- Marker + corrupted tmp → roll back to main (`recovered="rollback"`).

Commits are atomic: recovery never exposes a half-committed interval set.

## Tests

```
python -m unittest discover -s tests -v
```

Latest real output is recorded in `results.txt`.
