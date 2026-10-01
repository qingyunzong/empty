# xmerge

Recursive three-way merge over a commit graph (git-merge-recursive style),
Python 3.11 standard library only.

## Input

`graph.json`: an object mapping node id ->

```json
{
  "parents": ["<id>", ...],
  "tree": {"<path>": "<string value>", ...}
}
```

## CLI

```
python -m xmerge graph.json A B -o result.json
```

- stdout: the merged tree as JSON (conflicted paths are excluded).
- stderr: conflicted paths, one per line, sorted.
- `-o result.json`: also writes `{"tree": ..., "conflicts": [...]}`.
- Exit codes: `0` clean merge, `1` conflicts, `2` input error
  (unknown head, cycle, duplicate node id, malformed graph).

## Semantics

1. Ancestor sets of both heads are enumerated independently. Merge bases are
   the lowest common ancestors: common ancestors with no *other* common
   ancestor among their descendants. Unknown heads, cycles, or duplicate
   node ids exit with code 2.
2. A unique merge base contributes its tree directly. Multiple merge bases
   are merged pairwise in ascending id order, recursively, producing virtual
   base nodes.
3. Final per-path three-way merge (missing path == null): only one side
   changed -> take it; both changed to the same value -> take it; both
   changed differently, or modify/delete -> conflict.
4. If a path conflicts while constructing a virtual base, that path is a
   conflict in the final merge as well and is never auto-resolved.

## Tests

```
python3 -m unittest discover -s tests -v
```

Includes a cross-check on random DAGs of <= 10 nodes: independently
enumerated ancestor sets and merge bases are compared against a second,
independent lowest-common-ancestor implementation.

## Recorded real run results (2026-10-01, Python 3.14.4)

`python3 -m unittest discover -s tests -v` -> **Ran 23 tests, OK** (exit 0).

### 1. Unique base (`examples/unique_base.json A B`) -> exit 0

stdout tree: `{"a": "10", "b": "20", "c": "30", "e": "5"}`
(a: only A changed; b: only B changed; c: both -> same value; d: deleted by
A, untouched by B -> deleted; e: added by B). stderr empty, no conflicts.

### 2. Criss-cross (`examples/crisscross.json D E`) -> exit 1

Merge bases of D and E are `B1` and `C1`; their recursive merge conflicts on
`h` (1 vs 2 over base 0), so the virtual base keeps `h` conflicted. Even
though D and E agree on `h == "3"`, rule 4 keeps it a conflict.
stdout tree: `{"k": "x"}`; stderr: `h`.

### 3. No common root (`examples/no_common_root.json A B`) -> exit 1

Empty base: `x`, `y` adopted from the only side that has them, `same`
adopted (equal on both sides), `diff` conflicts (a vs b).
stdout tree: `{"same": "v", "x": "1", "y": "2"}`; stderr: `diff`.

### Error cases -> exit 2

- unknown head: `error: unknown head: 'ghost'`
- cycle: `error: cycle detected involving node 'A'`
- duplicate node id: `error: duplicate key: 'A'`
