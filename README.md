# safedelsync

Safe bidirectional directory synchronization with delete propagation,
using only the Python 3.11 standard library.

## Usage

```sh
python -m safedelsync sync LEFT RIGHT --state STATE.json
```

Prints a JSON stats object on stdout, e.g.
`{"copied": 2, "deleted": 1, "conflicts": 0}`.
Errors go to stderr; exit code `4` means the state file is corrupt,
`1` any other runtime error, `0` success.

## Semantics

The state file records, per path, the triple `(path, hash, exists)`
as of the last successful sync:

1. A path missing on one side whose state entry exists is a **deletion**
   and propagates; a path with no state entry is an **addition** and is
   copied, never deleted.
2. Delete vs concurrent modify: the **modify wins**, the file is restored
   on the deleting side, and a `<path>.conflict` copy is created.
3. Both sides changed to different contents: the **lexicographically
   smaller** content becomes official on both sides; the loser is kept
   in `<path>.conflict`.
4. Deletions leave a tombstone (`exists=false`) with the last hash, so a
   late-arriving write of the old content is discarded instead of
   resurrecting the file. Genuinely new content on the path is an add.
5. File operations are applied first and the state file is written
   atomically (temp file + fsync + rename) at the end, so an interrupted
   run can simply be re-executed: reruns are idempotent and the conflict
   count does not grow.

## Tests

```sh
python -m unittest discover -s tests -v
```

See `TEST_LOG.txt` for the recorded real run.
