# mealy-distinguish

State distinguishability analysis for deterministic Mealy machines, aimed at
black-box protocol implementations that need short test sequences to tell
internal states apart.  Pure Python 3.11 standard library; tests use
`unittest`.

Features:

- **Pairwise analysis**: state-pair distinguishing graph with the shortest
  preset witness sequence for every distinguishable pair.
- **Adaptive distinguishing trees**: the next input may depend on all
  previously observed outputs.  Subset search with lower-bound pruning
  minimises the worst-case test length (tree depth).
- **Exact infeasibility**: when no distinguishing tree exists, the tool
  returns the undistinguishable state subsets together with closure
  evidence computed over the reachable configuration graph — never just a
  greedy failure.
- **Partial transitions**: undefined transitions produce a dedicated error
  output `__error__` and enter the fault state `__fault__` (a sink).
- **Budget / pause / resume**: the search runs on a node budget; on
  exhaustion it returns the current tree plus a certified lower bound
  *without* claiming optimality, and the search state can be serialised and
  resumed later.
- **Certificate checker**: replays every branch of a candidate tree and
  verifies that each leaf is reached with exactly one candidate state left.
- At most 10 user-defined states per machine.

## Machine format (JSON)

```json
{
  "states": ["S1", "S2"],
  "inputs": ["a", "b"],
  "transitions": {
    "S1": {"a": ["S1", "0"]},
    "S2": {"a": ["S2", "0"], "b": ["S2", "1"]}
  }
}
```

Transition entries may be `["next", "output"]` pairs or
`{"next": ..., "output": ...}` objects.  Missing entries are undefined
transitions (here `S1` has none for `b`), completed with the error output
and the fault state.

## CLI

All commands read JSON and print one JSON document to stdout.

```sh
# Shortest witness for every state pair, equivalence classes, evidence
python3.11 -m mealy.cli pairs machine.json

# Adaptive distinguishing tree (minimum worst-case depth)
python3.11 -m mealy.cli tree machine.json [--set S1 S2 ...] [--budget N] [--resume state.json]

# Check a distinguishing-tree certificate
python3.11 -m mealy.cli verify machine.json cert.json [--set S1 S2 ...]

# Shortest preset (non-adaptive) distinguishing sequence, bounded search
python3.11 -m mealy.cli preset machine.json [--set S1 S2 ...] [--max-len N]
```

`tree` prints `status: optimal | partial | infeasible`.  A `partial` result
carries `resume_state`; save it and continue with
`--resume state.json --budget N`.  An `infeasible` result carries
`undistinguishable_subsets` and per-configuration closure `evidence`
(for every input: a candidate merge or an again-undistinguishable
successor).

## Library

```python
from mealy import MealyMachine, PairAnalysis, Solver, check_certificate, tree_to_json

machine = MealyMachine.from_dict(data)
analysis = PairAnalysis(machine)
analysis.witness("S1", "S2")        # shortest separating sequence, or None

result = Solver(machine).solve(["S1", "S2"], budget=10000)
result["status"]                    # "optimal" | "partial" | "infeasible"
check_certificate(machine, tree_to_json(result["tree"]), ["S1", "S2"])
```

## How it works

- `mealy/pairs.py` — reverse BFS over the pair graph: pairs with
  output-differing inputs have distance 1; a pair inherits `1 + distance`
  from an equal-output successor pair.  Unreached pairs are equivalent and
  come with bisimulation-style closure evidence.
- `mealy/tree.py` — configurations map each candidate initial state to its
  current state.  Iterative deepening over the worst-case depth with two
  admissible lower bounds (information-theoretic fan-out bound, and the
  maximum pairwise witness distance: a tree separates a pair only after
  replaying a preset witness along the shared path).  Solved and failed
  configurations are memoised (shared subproblems); failures that depended
  on cutting a no-progress cycle are deliberately not cached, keeping the
  cache sound.  Feasibility is decided exactly: a minimum-depth tree never
  repeats a configuration on a branch, so the reachable configuration graph
  bounds the depth, and the unsolvable configurations form the closure
  evidence reported on infeasibility.
- `mealy/exhaustive.py` — independent brute-force checkers (plain
  memoised recursion and sequence enumeration) used by the tests to
  cross-check optimal depths and witness lengths.
- `mealy/verify.py` — certificate checker.

## Tests

```sh
python3.11 -m unittest discover -s tests -v
```

The suite covers: pairwise distinguishable sets with no uniform preset
sequence (but an adaptive tree), adaptive branching, partial transitions
and the fault state, reused output names, shared subproblems across search
branches, pause/resume under tight budgets, exact infeasibility with
closure evidence, certificate replay (positive and negative), and
randomised cross-checks of the optimised solver against independent brute
force.

Recorded result on Python 3.11.16:

```
Ran 46 tests in 2.1s

OK
```
