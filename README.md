# Incremental Build Orderer (增量构建排序器)

A JSONL-driven CLI plus a Python library that maintains a directed graph under
incremental mutations and emits a deterministic topological order of the
currently executable nodes.

## Usage

```sh
python3 -m topo < commands.jsonl
```

One JSON command per line on stdin:

```json
{"op": "add_node", "node": "a"}
{"op": "add_edge", "src": "a", "dst": "b"}
{"op": "del_edge", "src": "a", "dst": "b"}
{"op": "del_node", "node": "a"}
{"op": "order"}
```

`order` prints `{"order": [...], "version": N}` to stdout. `version` is a
monotonic counter bumped only by mutations that actually change the graph.

## Semantics

- **Idempotent mutations**: re-adding an existing node or edge is a no-op and
  does not bump `version`; deleting a missing edge is a no-op.
- **Deterministic order**: Kahn's algorithm with a min-heap on node id, so
  ready nodes are always emitted in ascending id order — no hash/insertion
  order dependence. The cached order is recomputed only when the graph changed.
- **Local deletes**: deleting an edge can only unlock its successors; unrelated
  nodes keep their relative order (see `tests/test_core.py::TestDeleteEdgeLocality`).
- **Cycle safety**: a mutation that would close a cycle is rejected atomically
  (exit 3). The error payload contains the lexicographically smallest node set
  among cyclic strongly connected components (Tarjan SCC), and the graph keeps
  its last acyclic snapshot. Self-loops and multi-node cycles are reported
  through the same path.
- **Cascading delete**: `del_node` removes all incident edges.
- **Atomicity**: malformed commands and unknown-node references are validated
  before any mutation, so failures never partially apply.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | success |
| 2 | malformed JSON line / malformed command / unknown op |
| 3 | cycle detected (state unchanged, last acyclic snapshot kept) |
| 4 | unknown node referenced |

Errors are printed to stderr as JSON, e.g.
`{"error": "cycle", "nodes": ["a", "b"], "line": 4}`.

## Layout

- `topo/core.py` — `IncrementalTopo` library (graph, lex-min Kahn, Tarjan SCC)
- `topo/cli.py`, `topo/__main__.py` — JSONL CLI (`python3 -m topo`)
- `tests/test_core.py` — acceptance A–D and semantics tests
- `tests/test_cli.py` — CLI exit-code and determinism tests

## Test results

Command: `python3 -m unittest discover -s tests -v`

Run on 2026-10-01 with Python 3.14.4 (stdlib only, compatible with 3.11):

```
Ran 23 tests in 3.260s

OK
```

All 23 tests passed; no failures, no skips. Coverage of the acceptance criteria:

- **A** `TestIncrementalVsOfflineKahn`: 100 random small graphs, step-by-step
  `add_edge` compared against an independent offline Kahn reference after every
  step, plus 50 random op streams with cycle-rejection checks.
- **B** `TestDeleteEdgeLocality`: deleting the key edge `x->a` changes
  `[x, a, y, z]` to `[a, x, y, z]` — only the unlocked successor moves.
- **C** `TestCycleErrors` + CLI cycle tests: self-loop and 2-node cycle both
  raise `CycleError` / exit 3 with the sorted minimal node set, and the version
  counter proves the last acyclic snapshot is preserved.
- **D** `TestIdempotency` + CLI duplicate-edge test: repeated `add_edge`
  returns `False` and leaves `version` and `order` unchanged.
