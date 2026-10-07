# pathpolicy

File-access policy rulesets over a wildcard path-pattern language, with
**exact** inclusion / equivalence / difference checking.  Built to answer
the upgrade-safety question: *does the new policy allow any path the old
one did not?* — with a proof, not a sample.

Pure Python 3.11 standard library.  No dependencies.

## Pattern language

Paths are normalized before matching (empty and `.` segments dropped,
`..` resolved by popping, `..` escaping the root rejected).  The
separator `/` is distinct from ordinary characters: nothing below ever
matches it.

| syntax      | meaning                                                     |
|-------------|-------------------------------------------------------------|
| `a`, `x.y`  | literal characters                                          |
| `*`         | any run of non-separator characters inside one segment      |
| `?`         | exactly one non-separator character                         |
| `[abc]`     | one character of the set (ranges `a-z` supported)           |
| `[^ab]`/`[!ab]` | one character outside the set, still never `/`          |
| `**`        | whole segments only: zero or more complete segments         |
| `\x`        | escape a metacharacter                                      |

A **policy** is `{"allow": [...patterns], "deny": [...patterns]}` and
denotes the union of `allow` minus the union of `deny` (a bare pattern
string or list of patterns is an allow-only policy).

## How correctness is established

- Patterns compile to **symbolic automata** (transitions carry character
  predicates; the alphabet is partitioned into minterms, so set operations
  are exact over the infinite character universe).
- Inclusion `L ⊆ R` is decided as emptiness of
  `L ∩ ¬R ∩ Legal`, where `Legal` is the language of canonical
  (normalized) paths — the complement is relative to legal paths, never
  to arbitrary strings, and `**` matching zero segments cannot be
  confused with an empty segment.
- `included` results carry a **certificate**: the fully explored product
  graph.  `verify_certificate` rebuilds the automata from the policies
  and re-checks every transition, every accepting flag, completeness and
  reachability — an independently verifiable proof, not finite sampling.
- `not_included` results carry a **shortest difference witness** that is
  re-normalized and re-matched by the independent recursive interpreter
  on both sides before being returned.
- A state budget bounds the product construction; on exhaustion the
  result is `unknown` plus a serializable checkpoint holding the
  recoverable frontier, resumable later with a larger budget.

## CLI

```
python3.11 -m pathpolicy <op> [json-payload]     # payload or stdin
```

Ops: `normalize`, `match`, `policy-match`, `parse`, `includes`,
`equivalent`, `difference`, `verify`, `resume`.

```
$ echo '{"left": {"allow": ["a/**"]}, "right": {"allow": ["**"]}}' \
    | python3.11 -m pathpolicy includes
{ "ok": true, "result": "included", "certificate": {...}, ... }

$ echo '{"left": {"allow": ["**"]}, "right": {"allow": ["a/**"]}}' \
    | python3.11 -m pathpolicy difference
{ "ok": true, "result": "nonempty",
  "witness": {"path": "/", "normalized": "/",
              "left_match": true, "right_match": false}, ... }
```

## Library

```python
from pathpolicy import (Policy, check_inclusion, check_equivalent,
                        find_difference, verify_certificate,
                        match_pattern, normalize_path)
```

## Tests

```
python3.11 -m unittest discover -s tests -v
```

Covers: `**` zero-segment matches, consecutive separators, character-class
complements, whitelist/blacklist interaction, normalization folding two
inputs to one path, the empty root path, multiple same-length
counterexamples, budget exhaustion with `unknown` + frontier resumption,
certificate tamper detection, and a full enumeration cross-check of the
automaton pipeline against the independent recursive interpreter over a
small directory-name set.
