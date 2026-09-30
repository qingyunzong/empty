# safedelsync

State-based two-way directory synchronization with safe delete propagation.

## Usage

```
python -m safedelsync sync L R --state S
```

Prints a JSON summary to stdout, e.g. `{"copied": 1, "conflicts": 0, "deleted": 2}`.
Errors go to stderr; exit code `4` means the state file is corrupt.

## Semantics

1. The state file records the last-synced triple `(path, hash, exists)` per path.
2. A path missing on one side is a **deletion** only if the state says it
   existed; a present file with no live state entry is an **addition** and is
   never treated as a delete (no delete storms).
3. Concurrent delete vs modify: the **modify wins**, the modified content is
   restored on both sides, and a `<path>.conflict` copy is written.
4. Both sides changed with different content: the lexicographically smaller
   content becomes official on both sides; the other goes to
   `<path>.conflict`.
5. Anti-resurrection: after a delete propagates, the state keeps a tombstone
   `(hash, exists=false)`. A file reappearing with the exact tombstone hash is
   a stale echo and is deleted again; different content is a genuine new add.
6. Interruptible: the state file is written atomically (temp + rename) only
   after all file operations. A killed run simply re-runs; results converge
   and conflict counts do not grow.

## Tests

```
python -m unittest discover -s tests -v
```

Covers: enumerated interleaved add/delete/modify sequences converging (A),
single-side additions never deleted (B), no resurrection of stale content
after delete propagation (C), and kill-mid-sync rerun stability (D, via the
`SAFEDELSYNC_CRASH_AFTER` env hook that simulates SIGKILL after N operations).
