# cegen

Minimal counterexample generation and bounded proofs for finite-domain
policy invariants. Pure Python 3.11 standard library; tests use `unittest`.

## Usage

```
python -m cegen find spec.json --bound 6 [--max-steps N]
```

Prints `{"status", "counterexample", "stats"}` as JSON. Malformed specs
raise `PolicyError` and exit with code 2.

## Spec format

```json
{
  "variables": [
    {"name": "x",  "type": "int", "bound": 2},
    {"name": "ok", "type": "bool"},
    {"name": "xs", "type": "list", "max_len": 2,
     "elem": {"type": "int", "bound": 1}}
  ],
  "predicate": "x + len(xs) >= 1"
}
```

* `variables` is an ordered list; declaration order defines the
  lexicographic assignment order.
* Domains are explicit and finite: `int` in `[-B, B]` (`bound` per
  variable, else the CLI `--bound`), `bool`, and `list` of length
  `0..max_len` over an element domain.
* `predicate` is the invariant, evaluated with a safe environment
  (`abs, all, any, len, max, min, sum` plus the variables). A
  counterexample is an assignment where it is `False`.

## Semantics

* **Cost.** `int`: `|v|`; `bool`: `0/1`; `list`: `len + sum(elem costs)`.
  Assignment cost is the sum over variables.
* **Order.** Assignments are enumerated in non-decreasing cost layers;
  within a layer, lexicographically over the declared variable order
  (ints ascending, `False < True`, lists in natural tuple order). The
  first counterexample found is therefore cost-minimal, and
  lexicographically smallest among ties.
* **States.**
  * `COUNTEREXAMPLE` — the minimal counterexample (with its cost).
  * `PROOF` — the bounded space was exhausted and the invariant held;
    `stats.closure_hash` is the SHA-256 over the canonical JSON of every
    enumerated assignment in enumeration order.
  * `UNKNOWN` — the `--max-steps` evaluation budget was hit first;
    `stats.enumerated` reports how many assignments were checked.
    UNKNOWN is not a proof and carries no closure hash.
  * `INVALID_INPUT` — the predicate raised an exception or returned a
    non-boolean; this is a policy defect, never a counterexample.

## Tests

```
python -m unittest discover -s tests -v
```

Includes a property test that checks 1000 seeded random specs against an
independent `itertools` brute-force reference for status, enumerated
count, and counterexample minimality.
