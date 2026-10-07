# ghtree — Gomory-Hu cut trees with certified batch updates

A pure Python 3.11 (standard library only) implementation of Gomory-Hu
cut trees for undirected, integer-capacity multigraphs, with a JSON CLI.

* Parallel edges are aggregated per unordered pair; self-loops are
  ignored; capacity 0 is allowed.
* Every tree edge stores the cut side and capacity **at build time** plus
  a feasible max-flow of the same value (dual certificate).  Pairwise
  min-cut queries use the tree path minimum; the stored tree-edge sides
  are never trusted as certificates without re-validation.
* Batch capacity updates identify which stored cuts may be stale, reuse
  edges whose dual evidence still checks out (cut capacity == value ==
  feasible flow value, all against the *updated* graph), re-solve the
  rest, and report the reused / re-solved edge lists.  After repair the
  whole tree is independently verified (every pair's path minimum vs. a
  fresh max-flow); if the topology no longer certifies all pairs it is
  rebuilt from scratch.
* Partitions are canonicalised: each cut side is stored as the sorted
  vertex list containing vertex 0, and all construction loops iterate in
  sorted order, so results never depend on set iteration order.
* Illegal updates (negative / non-integer capacities, unknown vertices)
  raise `UpdateError` and roll back graph, tree and query cache together.
  States serialise to JSON and restore exactly.

## Library

```python
from ghtree import Graph, CutTree

g = Graph(4, [(0, 1, 8), (1, 2, 3), (2, 3, 8), (0, 3, 1), (1, 2, 2)])
tree = CutTree(g)
tree.query(0, 3)            # -> 6 (min 0-3 cut)
tree.verify()               # -> [] (independent audit, empty = ok)
report = tree.update([(1, 2, 10), (0, 3, 6)])
# -> {"reused": [...], "resolved": [...], "rebuilt": False}
state = tree.to_state()     # JSON-serialisable snapshot
tree2 = CutTree.from_state(state)
```

## CLI

```sh
# build a tree (graph JSON from file or stdin)
python3.11 -m ghtree build --graph graph.json --save state.json

# query pairwise min-cut values
python3.11 -m ghtree query --state state.json --pairs '[[0, 3], [1, 2]]'

# batch capacity update; prints reused/resolved edge lists
python3.11 -m ghtree update --state state.json \
    --updates '[[1, 2, 10], {"u": 0, "v": 3, "capacity": 6}]' \
    --save state.json

# independent certificate verification (exit code 0/1)
python3.11 -m ghtree verify --state state.json
```

### JSON formats

* Graph: `{"n": 4, "edges": [[u, v, cap], ...]}` (objects with
  `u`/`v`/`capacity` keys are also accepted).
* Updates: `[[u, v, new_cap], ...]` — sets the *aggregated* capacity of
  the unordered pair.
* State: capacities plus, per tree edge, `endpoints`, `value`,
  `cut_side` (canonical), `source`/`sink` and the certificate `flow`.

## Tests

```sh
python3.11 -m unittest discover -s tests -v
```

The suite enumerates **all** cuts of every pair for random graphs up to
8 vertices and cross-checks the tree, before and after random batch
updates.  It also covers zero-capacity disconnection, parallel-edge
aggregation, bridge capacity up/down, batch updates that leave an old
cut side legal but non-minimal, tampered flow/cut/value certificates,
illegal-update rollback, and save/restore consistency.
