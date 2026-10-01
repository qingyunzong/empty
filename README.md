# Add-Wins OR-Set (Python 3.11, stdlib only)

State-based observed-remove set with unique tags `(node, counter)`, tombstones,
and watermark-based compaction.

## Semantics
1. `add(e)` mints a fresh globally unique tag `(node, counter)`.
2. `remove(e)` tombstones only the tags visible at the remover; concurrent
   adds survive (add-wins).
3. `merge` = union of add-sets minus union of remove-sets; commutative,
   associative, idempotent.
4. `compact` folds dead tags observed by all nodes into per-element summary
   watermarks `{node: max_dead_counter}`; folded removes stay rejected on
   replay. Requires a quiescence barrier (all nodes observed the state).
5. A remove never affects an add not yet delivered to the remover.

## CLI (JSON lines in, JSON lines out; errors exit 4)
```
python orset.py add       {"node": "A", "element": "x", "state": null}
python orset.py rem       {"state": S, "element": "x"}
python orset.py merge     {"states": [S1, S2]}
python orset.py compact   {"state": S, "nodes": ["A", "B"]}
python orset.py contains  {"state": S, "element": "x"}
python orset.py dump      {"state": S}
```

## Tests
```
python -m unittest discover -s tests -v
```
