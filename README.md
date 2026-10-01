# lazydfa

Lazy NFA -> DFA conversion for streaming recognition, in pure
Python 3.11 standard library.  Built for pattern sets that must be
determinized on demand without state explosion taking down the service.

## Features

- **NFA with epsilon edges and integer-interval transitions**
  (`lazydfa/nfa.py`).  Symbol edges carry an inclusive `[lo, hi]`
  integer interval; the character domain is never enumerated.
- **Epsilon-SCC closure index** (`lazydfa/closure.py`).  The epsilon
  graph is condensed into strongly connected components (iterative
  Kosaraju); closures are unions of per-SCC reachability sets over the
  condensation DAG.  The index is keyed to the NFA epsilon version, so
  deleting an epsilon edge that splits an SCC can never leave a stale
  closure behind.
- **Lazy subset construction** (`lazydfa/dfa.py`).  DFA states are
  expanded one at a time; transitions are computed by splitting the
  integer line at the endpoints of reachable interval edges (atomic
  segments), not by walking the alphabet.
- **Budgets**.  `state_budget` / `transition_budget` bound how much of
  the machine is materialized.  Anything not constructed answers
  `unknown` from `query` -- never `reject`.
- **Checkpoints**.  `to_dict` / `from_dict` capture discovered subsets,
  the expansion frontier and the canonical state numbering.  Restoring
  any number of times yields exactly the machine of a single run.
  A `format_version` mismatch raises `CheckpointError`.
- **Incremental invalidation**.  Adding or removing NFA edges
  invalidates only the DFA states whose closure/subset dependencies
  include the edge (plus their ancestors), then re-expands lazily.
- **Witnesses**.  Every DFA transition records the ids of the NFA
  edges that witness it, for independent verification.
- **Reference interpreter** (`lazydfa/interp.py`).  An independent
  set-based epsilon-closure simulator used to cross-check the DFA.

## Library usage

```python
from lazydfa import LazyDFA, NFA

nfa = NFA(3, start=0, finals=[2])
nfa.add_edge(0, 1)                    # epsilon
nfa.add_edge(1, 0)                    # epsilon cycle
nfa.add_edge(1, 2, lo=97, hi=122)     # [a-z]

dfa = LazyDFA(nfa, state_budget=100, transition_budget=500)
dfa.expand_all()
assert dfa.query("q") == "accept"

checkpoint = dfa.to_dict()            # JSON-serializable
resumed = LazyDFA.from_dict(checkpoint)
assert resumed.query("q") == "accept"
```

## CLI

```sh
# Build a machine checkpoint (JSON) from an NFA description.
python3.11 -m lazydfa build nfa.json [--state-budget N] \
    [--transition-budget M] [--no-expand] > machine.json

# Resume / expand a checkpoint (this is also how checkpoints resume).
python3.11 -m lazydfa expand machine.json [--steps K] > machine2.json

# Query: accept / reject / unknown (exit 0 only on accept).
python3.11 -m lazydfa query machine.json "a5"
python3.11 -m lazydfa query machine.json "[97, 56]"

# Cross-check the DFA against the reference interpreter.
python3.11 -m lazydfa check nfa.json --max-len 4
```

NFA JSON format:

```json
{"num_states": 3, "start": 0, "finals": [2],
 "edges": [{"id": 0, "src": 0, "dst": 1, "lo": null, "hi": null},
           {"id": 1, "src": 1, "dst": 2, "lo": 97, "hi": 122}],
 "next_edge_id": 2, "version": 2, "eps_version": 1}
```

(`lo: null` marks an epsilon edge.)

## Tests

```sh
python3.11 -m unittest discover -s tests -v
```

Latest run: **33 tests, all OK** (~6.5 s).  Coverage includes epsilon
cycles, empty-string acceptance, overlapping interval endpoints,
budgets exhausted exactly, language shrinkage after deleting a cycle
edge, atomic rejection at bad endpoints, checkpoint version mismatch,
checkpoint/resume equivalence with one-shot runs, and randomized
cross-checks of small NFAs against the reference interpreter over all
short strings.
