# tag-dag

Taxonomy library that manages tags as a DAG (directed acyclic graph).
An edge `parent -> child` means `child` is categorized under `parent`;
every tag counts as an ancestor (and descendant) of itself.

## API

- `addTag(id)` / `addEdge(parent, child)` / `removeEdge(parent, child)` —
  build the graph; ids are `string | number`.
- `applyEdgeBatch(ops)` — applies a batch of `{type: "add" | "remove",
  parent, child}` operations atomically. The whole batch is validated on a
  scratch copy and rejected with `CycleError` (graph untouched) if the
  result would contain a cycle, or `UnknownTagError` for unknown tags.
- `ancestorsOf(id)` / `descendantsOf(id)` — transitive closure including
  the tag itself.
- `lowestCommonAncestors(a, b)` — all common ancestors of `a` and `b` that
  have no strictly closer common descendant (no other common ancestor is a
  strict descendant of them). Result is sorted by tag id.

## Test

```sh
npm test
```

Compiles with `tsc` and runs `node --test`. The suite cross-checks the
library against an independent per-node ancestor-set model on deterministic
cases (multiple LCAs, self-pairs, diamonds, disconnected tags, sorting) and
on seeded random DAGs and random batch edits.
