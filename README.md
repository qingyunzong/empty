# symdfa — symbolic DFA minimization with equivalence proofs

Minimizes deterministic finite automata whose edge labels are **integer
character intervals**, using partition refinement.  No character is ever
enumerated: all operations are interval arithmetic over an alphabet
`[0, alphabet_size)`.  Built for rule services that need to compress large
state machines *and* explain why merged states are equivalent.

Pure Python 3.11 standard library; tests use `unittest`.

## Layout

- `symdfa/intervals.py` — interval-set algebra; rejects overlapping or
  adjacent input intervals (`IntervalError`).
- `symdfa/automaton.py` — `SymbolicDFA` (partial DFAs allowed: missing
  edges reject), reachability trimming with canonical BFS renumbering.
- `symdfa/partition.py` — the refinement engine.  Maintains an **inverse
  transition index by interval events** (`target -> [(lo, hi, pred)]`),
  worklist splitting, and a completion-aware re-merge fixpoint (a virtual
  DEAD sink lets dead-equivalent states merge).  `apply_changes` commits
  batch final/transition updates only after every block passes an
  independent transition-stability check; on failure the previous
  partition and index are restored.
- `symdfa/minimizer.py` — canonical quotient numbering (BFS from the
  start block over sorted interval edges = lexicographically shortest
  reaching word order), block map, and the shared proof DAG of shortest
  distinguishing words.
- `symdfa/certificate.py` — independent verifier.  Never imports the
  minimizer; re-derives every check (stability, canonical numbering, DAG
  validity *and* minimality via its own symbolic BFS oracle).
- `symdfa/naive.py` — reference oracle: pairwise-equivalence fixpoint
  with explicit per-character expansion (tests only).
- `symdfa/cli.py` — JSON CLI.

## Certificate format

`minimize` / `apply` emit:

```json
{
  "alphabet_size": 2,
  "quotient":  { "num_states": 4, "start": 0, "finals": [3],
                 "transitions": [[{"intervals": [[0,0]], "target": 1}]] },
  "block_map": {"0": 0, "1": 1, "4": 1},
  "proof_dag": {
    "nodes": [{"id": 0, "kind": "accept", "side": 0},
              {"id": 1, "kind": "step", "char": 0, "child": 0}],
    "pairs": {"0,3": 1}
  }
}
```

- `quotient` — the minimized automaton, states numbered `0..k-1` by BFS
  from the start over sorted interval edges (lexicographic shortest-word
  order); isomorphic inputs serialize identically.
- `block_map` — original reachable state id -> quotient state.
  Unreachable states are trimmed and absent.
- `proof_dag` — for every pair of states in different blocks, a node
  whose chain spells a shortest distinguishing word: `step` consumes
  `char` and continues at `child`; `accept` is a leaf where exactly
  `side` accepts the empty word.  Chains are shared, so proofs form a
  DAG.  Nodes are built on the canonical quotient, hence
  relabelling-invariant.

## CLI

```sh
python3.11 -m symdfa.cli minimize machine.json -o cert.json
python3.11 -m symdfa.cli apply machine.json changes.json -o cert2.json
python3.11 -m symdfa.cli verify machine.json cert.json
```

`changes.json` may contain `finals` and/or `transitions` (batch update,
applied incrementally).  On failure the previous partition is restored
and the command exits non-zero.

## Library

```python
from symdfa import SymbolicDFA, Minimizer, verify_certificate

dfa = SymbolicDFA(2, 3, 0, [2], [
    [([(0, 0)], 1)],          # 0 -a-> 1
    [([(0, 0)], 2)],          # 1 -a-> 2
    [([(0, 1)], 2)],          # 2 -a,b-> 2
])
m = Minimizer(dfa)
cert = m.result()             # full certificate
m.apply_changes(finals=[1])   # incremental batch update, with rollback
assert verify_certificate(m.dfa, m.result()) == []
```

## Tests

```sh
python3.11 -m unittest discover -s tests -v
```

Covers: unreachable finals, empty languages, overlap rejection, cascading
splits from a single final-state change plus re-merge on revert,
incremental vs full-rebuild equivalence (randomized), cross-check against
the naive pairwise fixpoint oracle, canonical numbering, isomorphic
serialization, certificate tampering, rollback, and a 2^20-symbol
alphabet to prove nothing expands per character.
