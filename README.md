# hierosync

Hierarchical directory snapshot versioning with subtree-scoped rollback.
Python 3.11+ standard library only.

## Model

- A **repository** is a directory tree; the **snapshot store** (`SNAP`, e.g.
  `repo/.hs`) lives directly inside the repository root, which is derived as
  the parent directory of `SNAP`.
- Each **snapshot** (`SNAP/snapshots/<id>.json`) records a full manifest
  (relative path -> `{type, hash}`), a parent pointer, a nanosecond
  timestamp and a monotonic sequence number. Together `(time_ns, seq)` give
  a total order over commits, including concurrent ones.
- File contents are kept in a content-addressed object store
  (`SNAP/objects/<sha256>`) so undone deletions can be restored.
- `SNAP/HEAD` points at the newest snapshot; `SNAP/SEQUENCE` holds the
  last-used sequence number.

## CLI

```
python -m hierosync commit ROOT SNAP [--undo N]
```

- `commit` snapshots the whole repository and prints
  `{"committed": <id>, "undone": [], "skipped": []}` as JSON on stdout.
- `--undo N` rolls back the changes of the most recent N commits that fall
  inside the subtree `ROOT`; changes outside the subtree are preserved.
  Output: `committed` = new snapshot id, `undone` = commits reverted
  (newest first), `skipped` = examined commits with no in-subtree changes.
- Empty-directory rule: if a rollback leaves a directory empty and that
  directory was created by an undone commit, it is deleted; otherwise kept.
- After a rollback the tree is rescanned and hashes recomputed, so every
  root-to-leaf path exists and the stored manifest matches the disk.

## Exit codes

- `0` success; `2` usage/operational error (message on stderr);
- `5` snapshot-store corruption: unreadable snapshot, dangling or cyclic
  parent pointer, corrupt `HEAD`/`SEQUENCE`. Detected before any write, so
  no new snapshot is created.

## Tests

```
python -m unittest discover -s tests -v
```

- `tests/test_random_model.py` — random op sequences (n=200, several seeds)
  compared node-by-node against an independent in-memory reference model.
- `tests/test_siblings.py` — rollback spanning sibling branches leaves
  siblings untouched.
- `tests/test_interleaved.py` — interleaved undo-of-create / undo-of-delete
  sequences are deterministic.
- `tests/test_corruption.py` — corrupted parent pointers exit with code 5
  and write no new snapshot.
