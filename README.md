# xmerge

Recursive three-way merge over a commit DAG (Python 3.11+, stdlib only).

## Input

`graph.json`: object mapping node id -> `{"parents": [id, ...], "tree": {path: value}}`.

## Usage

```
python -m xmerge graph.json A B -o result.json
```

- stdout: merged tree as JSON (conflicted paths omitted)
- stderr: conflicting paths, one per line
- `-o`: also write the merged tree JSON to a file

Exit codes: `0` clean merge, `1` conflicts, `2` errors (unknown head, cycle, duplicate node id, malformed graph).

## Semantics

1. Ancestor sets of both heads are enumerated independently; merge bases are
   the lowest common ancestors (common ancestors with no common-ancestor
   descendant).
2. A single merge base supplies the base tree directly. Multiple merge bases
   are merged pairwise in ascending id order, recursively, into a virtual base.
3. Per-path three-way merge (missing path == null): change on only one side is
   adopted; identical changes on both sides are adopted; differing changes and
   modify/delete are conflicts.
4. A path that conflicts while constructing a virtual base stays conflicted in
   the final result; no auto-resolution is attempted.

## Tests

```
python -m unittest discover -s tests -v
```
