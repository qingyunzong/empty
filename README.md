# symdfa — symbolic DFA equivalence & inclusion

Decides whether two symbolic DFAs accept exactly the same words (or whether
one language includes the other) **before a protocol upgrade**, and produces
either a checkable equivalence proof or the shortest counterexample.

- Alphabet: integers `0..65535`.
- Transitions: disjoint closed intervals `[lo, hi] -> dst` per state.
- Missing transitions fall into an implicit reject sink.
- The product space is explored on demand by splitting overlapping
  intervals into segments — characters are never enumerated individually.
- Counterexamples are minimal in (length, lexicographic) order.
- Budgets are charged per *new product edge*; exhaustion returns `unknown`
  plus a resumable frontier (`SearchState`).
- Proofs are bound to machine versions. After a single-transition
  correction, `revalidate` keeps the still-valid relation items as a reuse
  cache; only invalidated pairs are re-explored.
- An independent verifier checks relation coverage item by item, or replays
  a witness character by character.

## Library

```python
from symdfa import DFA, check_equivalence, build_proof, revalidate, verify_proof

a = DFA(2, 0, {1}, {0: [(0, 9, 1)]})
b = DFA(2, 0, {1}, {0: [(0, 19, 1)]})
res = check_equivalence(a, b)          # status, witness, edges_used
proof = build_proof(res, a, b)         # when status == "equivalent"
ok, reason = verify_proof(proof, a, b)

b.set_transition(0, 0, 19, 0)          # atomic; overlaps are rejected
cache = revalidate(proof, a, b)        # still-valid items survive
res2 = check_equivalence(a, b, cache=cache, budget=1000)
if res2.status == "unknown":
    res3 = check_equivalence(a, b, budget=1000, resume=res2.state)
```

## JSON CLI

```
python3.11 -m symdfa request.json      # or pipe the request via stdin
```

Commands: `equivalence`, `inclusion` (with optional `"budget"`),
`verify-proof`, `replay-witness`. See `symdfa/cli.py` docstring for the
exact request/response shapes.

## Tests

```
python3.11 -m unittest discover -s tests -v
```
