# ghtree — Gomory-Hu cut trees with verifiable certificates

Undirected, integer-capacity **multigraph** (parallel edges are aggregated,
capacity 0 is allowed, self-loops are ignored).  Pure Python 3.11 standard
library.

* `GomoryHuTree` answers the min cut between **any** pair of vertices: the
  value is the minimum edge weight on the tree path (Gusfield's
  construction, `n-1` max-flows via Dinic).
* Every tree edge stores the **actual cut side and capacity** observed at
  build/repair time plus a **feasible flow** of the same value — "double
  evidence" (cut == flow) for the edge weight.
* `query_cut` never trusts tree-edge sides blindly: a stored side is
  returned only after checking it separates the pair and its capacity in
  the current graph equals the path value; otherwise a fresh max-flow
  supplies the certificate.
* `update(batch)` validates the whole batch first — illegal updates
  (negative/non-integer capacity, unknown vertex) roll graph, cache and
  tree back to the exact previous state.  Each stored cut is then
  re-validated against the new residual state; cuts that still have double
  evidence are reused, the rest are re-solved by a rebuild that reuses the
  verification certificates.  The report lists `possibly_invalid`-suspect,
  `reused` and `recomputed` edges.
* `verify()` independently checks every edge certificate (cut separates
  endpoints, cut capacity == weight == feasible flow value) and every
  pair's tree-path value against the certificate constraints.
* `to_dict()` / `from_dict()` give JSON-safe persistence; all partitions
  are normalised by an explicit sort rule (`sorted` labels, sides ordered
  lexicographically), so results never depend on set iteration order.

## Library

```python
from ghtree import GomoryHuTree

tree = GomoryHuTree(["a", "b", "c"],
                    [("a", "b", 4), ("b", "c", 4), ("a", "c", 4)])
tree.query("a", "b")          # 8
tree.query_cut("a", "b")      # value + normalised partition + certificate
report = tree.update([("a", "c", 0)])
tree.verify()["ok"]           # True
state = tree.to_dict()        # JSON-safe; GomoryHuTree.from_dict(state)
```

## JSON CLI

Reads a request from stdin (or a file argument) and writes JSON:

```sh
echo '{"graph": {"vertices": ["a","b","c"],
                 "edges": [["a","b",4],["b","c",4],["a","c",4]]},
        "operations": [{"op": "query", "pairs": [["a","b"]]},
                       {"op": "update", "updates": [["a","c",0]]},
                       {"op": "query", "pairs": [["a","b"]]},
                       {"op": "verify"}]}' | python3.11 -m ghtree
```

The response `state` can be fed back as `"state"` in a later request to
keep querying/updating the same tree.  Operations: `query` (pairs),
`update` (batch capacity replacement), `verify`, `state`.

## Tests

```sh
python3.11 -m unittest discover -s tests -v
```

Includes brute-force cross-checks against enumeration of **all** cuts of
every pair for graphs up to 8 vertices, zero-capacity disconnection,
parallel-edge aggregation, bridge capacity up/down, batches that leave old
cut sides legal but non-minimal, tampered certificate flows, illegal-update
rollback, and save/restore consistency.
