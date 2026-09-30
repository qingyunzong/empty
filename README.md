# hierosync

Hierarchical directory version snapshots with subtree-scoped undo.
Pure Python 3.11 standard library; tests use `unittest`.

## CLI

```
python -m hierosync commit ROOT SNAP [--undo N]
```

- `commit ROOT SNAP` snapshots every node (files and directories,
  including empty directories) under `ROOT` into the store at `SNAP`.
  Each snapshot records per-node content hashes and a parent pointer.
- `--undo N` rolls back the changes of the most recent `N` commits that
  fall inside the target subtree: the tree is restored to the state
  preceding those commits, materialised into `ROOT`, and recorded as a
  new commit on top of the chain.  Commits outside the window are
  preserved.  `N` larger than the history clamps to the empty tree.

stdout is a JSON object `{"committed": id, "undone": [...], "skipped": [...]}`:

- `committed` — id of the newly created commit.
- `undone` — ids of the reverted commits (most recent first).
- `skipped` — commits inside the undo window that introduced no change.

Errors go to stderr.  Exit codes: `0` ok, `2` usage error,
`5` store corruption (cyclic/dangling parent pointers, malformed
metadata, broken timestamp order, non-recomputable hashes).  The whole
chain is validated before anything is written, so a corrupt store never
produces a new snapshot.

## Semantics

1. A node is a directory tree; snapshots store content hashes
   (files: sha256 of content; directories: sha256 of their sorted
   children) plus a parent pointer.
2. `undo N` reverts the in-subtree changes of the most recent `N`
   commits; commits outside the window are preserved.
3. If the rollback empties a directory that was created by an undone
   commit, the directory is deleted; a pre-existing empty directory is
   kept.
4. Commits on the same subtree are totally ordered by strictly
   increasing timestamps; cyclic parent pointers are rejected with exit
   code 5.
5. After a rollback every root-to-leaf path exists and all hashes are
   recomputed and verified before the new snapshot is written.

## Store layout

```
SNAP/
    HEAD               # id of the current head commit
    commits/<id>.json  # id, parent, timestamp, seq, root, tree_hash
    trees/<id>.json    # relpath -> [type, hash]
    objects/<sha256>   # content-addressed file blobs
```

## Tests

```
python -m unittest discover -s tests -v
```

Covers: (A) random operation sequences (n <= 200) checked node-by-node
against a reference model, (B) undo across sibling branches, (C)
interleaved undo of creates/deletes for determinism, (D) corrupt parent
pointers yielding exit code 5 without writing a new snapshot.
