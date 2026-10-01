# fdsolver

Finite-domain constraint solver (Python 3.11, standard library only).

* Variables are finite sets of integers.
* Constraints: allowed-tuple **table** constraints (valid-tuple support
  maintained, propagated to a common fixpoint) and **allDifferent**
  filtered with Régin's algorithm — bipartite maximum matching plus
  alternating-path / strongly-connected-component decomposition, removing
  every edge that belongs to no complete matching (not just edges touched
  by assigned variables).
* Nested `push()`/`pop()` and `remove_constraint()` restore previously
  removed values and support information exactly: the propagated state is
  recomputed as a pure function of (base domains, active constraints,
  decisions), never approximated by clearing queues.
* Search is pausable one node at a time, JSON-serializable and resumable;
  outcomes are `sat` (complete witness), `unsat` (independently replayable
  branch conflict tree) or `unknown` (only when the node budget is
  exhausted). A non-empty propagation result merely means "not refuted".
* Bad references, duplicate variables/ids and malformed tuples are
  rejected atomically — validation completes before any mutation.
* All JSON output is deterministically sorted.

## Library API

```python
from fdsolver import Solver, Searcher, verify_unsat_certificate, all_solutions

s = Solver()
s.add_variable("a", [1, 2])
s.add_variable("b", [1, 2])
s.add_variable("c", [1, 2, 3])
s.push()
cid = s.add_constraint("allDifferent", ["a", "b", "c"])
assert s.domains["c"] == {3}          # Hall set {a,b} forces c = 3
s.pop()                               # domains fully restored
assert s.domains["c"] == {1, 2, 3}

spec = {"variables": {"a": [1, 2], "b": [1, 2]},
        "constraints": [{"type": "allDifferent", "vars": ["a", "b"]}]}
sch = Searcher(spec, budget=1000)
sch.run()                             # "sat" | "unsat" | "unknown"
sch.witness                           # complete assignment when sat

# pause / serialize / resume after every single node
sch = Searcher(spec)
while sch.status is None:
    sch.step()
    blob = sch.to_json()              # JSON-safe; Searcher.from_json(blob)

# unsat certificates replay independently; tampering fails verification
ok = verify_unsat_certificate(spec, sch.tree)
```

## JSON CLI

Reads one request from a file argument or stdin, writes one
deterministically sorted JSON response.

```console
$ python3.11 -m fdsolver examples/hall.json
{
  "nodes": 2,
  "status": "sat",
  "witness": {
    "a": 1,
    "b": 2,
    "c": 3
  }
}

$ python3.11 -m fdsolver examples/unsat.json
{
  "certificate": {
    "branches": [
      {
        "child": "conflict",
        "value": 1
      },
      {
        "child": "conflict",
        "value": 2
      }
    ],
    "var": "x"
  },
  "nodes": 3,
  "status": "unsat"
}

$ python3.11 -m fdsolver examples/verify.json
{
  "status": "ok",
  "valid": true
}
```

Commands: `propagate` (fixpoint domains + removal log), `solve`
(`budget`, `find_all` options; emits `witness`/`certificate`), `verify`
(checks an unsat conflict tree by independent replay).

## Tests

```console
$ python3.11 -m unittest discover -s tests -v
```

Covers: Hall-set pruning, Régin edge removal beyond assigned variables,
arc-consistent-but-unsat table networks, two-level rollback and
allDifferent removal restoring domains and support info, one-node-at-a-time
search with save/restart matching continuous runs, tampered certificates
failing verification, atomic rejection of bad input, deterministic CLI
output, and randomized networks (≤6 variables, domain size ≤4) checked
solution-by-solution and removal-by-removal against independent brute-force
enumeration.
