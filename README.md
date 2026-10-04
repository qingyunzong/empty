# pathpolicy

A path-pattern policy engine for file-access rules.  Patterns compile to
symbolic automata, so upgrades can **prove** that the allowed path set did
not grow unexpectedly — inclusion and equivalence are decided exactly by
automaton emptiness, never by sampling.

Pure Python 3.11 standard library.  No dependencies.

## Pattern language

A pattern is a `/`-separated list of segments, matched against normalized
relative paths:

| Syntax        | Meaning                                                        |
|---------------|----------------------------------------------------------------|
| `literal`     | exact segment; `?` = any single ordinary char, `\` escapes      |
| `[abc]`,`[a-z]` | character class; `[^abc]` / `[!abc]` = complement class      |
| `*`           | exactly one non-empty segment                                  |
| `**`          | zero or more whole segments                                    |
| `""`          | the empty pattern matches only the root path                   |

The separator `/` is a dedicated automaton symbol: it never appears inside
a character predicate, and a complement class never matches it.  `**`
zero-segment matches never produce empty segments (`a//b`) or stray
separators.

Rule sets combine patterns with union and difference:

```json
"a/**"                                  // a single pattern
{"union": ["a/**", "b/*"]}              // union
{"minus": ["**", "secret/**"]}          // difference
{"allow": ["**"], "deny": ["secret/**"]}  // policy: allow minus deny
```

Differences take the complement **relative to the legal path language**
(normalized relative paths), not relative to arbitrary strings.

## Path normalization

`normalize_path` collapses consecutive separators, resolves `.` and `..`,
maps the root to `""`, and rejects any path whose `..` would escape the
root (`PathError`).  All matching normalizes first, so `a//./b/` and
`a/b` are the same path.

## Library usage

```python
from pathpolicy import (
    Pattern, Union, Minus, expr_from_json, expr_match,
    check_inclusion, check_equivalence, find_difference,
    verify_inclusion_proof,
)

old = expr_from_json({"allow": ["src/**"], "deny": ["src/secret/**"]})
new = expr_from_json({"allow": ["src/**", "tests/**"], "deny": ["src/secret/**"]})

check_inclusion(old, new)        # {"status": "included", "proof": {...}}
check_inclusion(new, old)        # {"status": "not_included", "witness": "tests", ...}
verify_inclusion_proof(old, new, proof)  # independent re-verification
```

* **Inclusion / equivalence** are decided by emptiness of the product
  `DFA(A) × DFA(L \ B)` over a finite minterm alphabet (mentioned chars +
  `OTHER` + `/`).  An empty product yields an **independently verifiable
  proof**: the full reachable product graph, which a verifier replays
  against its own recomputation of the component automata.
* **Shortest difference** witnesses come from BFS over the product; every
  witness is re-normalized and re-checked by both sides of an independent
  recursive interpreter before being reported.  `all_shortest=True`
  enumerates multiple same-length counterexamples.
* **State budget**: every construction takes a budget.  Exhaustion
  returns `{"status": "unknown", "frontier": [...]}`; the frontier is a
  resumable search state (`determinize(..., resume=partial)`).

## JSON CLI

Each command reads one JSON document from stdin and writes JSON to stdout:

```console
$ echo '{"path": "a//./b/"}'        | python3.11 -m pathpolicy.cli normalize
$ echo '{"expr": "a/**", "path": "a/b"}' | python3.11 -m pathpolicy.cli match
$ echo '{"a": "a/[bc]", "b": {"union": ["a/b", "a/c"]}}' | python3.11 -m pathpolicy.cli check
$ echo '{"a": "a/**", "b": "a/*/c", "all_shortest": true}' | python3.11 -m pathpolicy.cli diff
$ echo '{"a": "a/b", "b": "a/**", "proof": {...}}' | python3.11 -m pathpolicy.cli verify
$ echo '{"expr": "a/**/b", "names": ["a","b"], "depth": 3}' | python3.11 -m pathpolicy.cli enumerate
```

`check` reports both inclusion directions, equivalence, witnesses for
differences and proofs for inclusions.  `verify` independently re-checks a
proof.  `enumerate` cross-checks the automaton against the independent
interpreter on every legal path over a small name set.

## Layout

* `pathpolicy/normalize.py` — path normalization, root-escape rejection
* `pathpolicy/pattern.py` — pattern parser
* `pathpolicy/chars.py` — symbolic character predicates, minterm alphabet
* `pathpolicy/nfa.py` — pattern → symbolic NFA (boundary-state `**` handling)
* `pathpolicy/dfa.py` — determinization, products, budgets/frontiers, legal-path DFA
* `pathpolicy/ruleset.py` — union/difference expressions, compilation
* `pathpolicy/interpreter.py` — independent recursive matcher (`re`-based)
* `pathpolicy/proof.py` — inclusion/equivalence/difference, proofs, verification
* `pathpolicy/enumerate.py` — small-name-set enumeration cross-checks
* `pathpolicy/cli.py` — JSON CLI

## Tests

```console
$ python3.11 -m unittest discover -s tests -v
```

Covers normalization (consecutive separators, `..` escapes, empty root),
`**` zero-segment matching in all positions, character-class complements,
whitelist/exclude policy interaction, normalization-based path equality,
multiple same-length counterexamples, budget exhaustion with resumable
frontiers, proof verification (including tampered proofs), CLI round
trips, exhaustive small-name-set cross-checks and seeded fuzzing.
