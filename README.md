# cegen

Minimal counterexample generator over finite domains. Given a policy
invariant, `cegen` either returns the minimal counterexample, proves none
exists within the bound, or reports `UNKNOWN` when a resource limit is hit
(`UNKNOWN` is never a proof of safety).

## Spec format

```json
{
  "variables": [
    {"name": "x", "type": "int"},
    {"name": "flag", "type": "bool"},
    {"name": "xs", "type": "list", "elem": {"type": "int"}, "max_len": 2}
  ],
  "predicate": "not flag or x + sum(xs) <= 2",
  "bound": 6
}
```

- `int`: integers in `[-B, B]` (`B` from `--bound`, else spec `bound`, else 3)
- `bool`: `False`, `True`
- `list`: lists of length `<= L` (`max_len` per variable, else `--max-len`,
  else spec `max_len`, else 2); `elem` may itself be `int`/`bool`/`list`
- `predicate`: a Python expression over the variables; safe builtins:
  `abs all any len max min sorted sum`

## Cost model and minimality

- cost of `x: int` is `abs(x)`; of `b: bool` is `0/1`; of a list is
  `len(xs) + sum(element costs)`
- assignments are enumerated layer by layer of increasing total cost; within
  a layer, lexicographically by canonical domain order
  (`int`: `0, -1, 1, -2, 2, ...`; `bool`: `False, True`; lists by
  `(cost, element indices)`)
- the first falsifying assignment in this order is returned: the unique
  minimal counterexample (ties broken lexicographically)

## Statuses

- `COUNTEREXAMPLE`: minimal falsifying assignment found
- `PROOF`: predicate holds on the whole finite space; `stats.closure_hash`
  is the SHA-256 of the canonical enumeration closure
- `UNKNOWN`: `--max-enumerated` limit reached; `stats.enumerated` reports
  how many assignments were checked. **Not** a proof.
- `INVALID_INPUT`: the predicate raised an exception on some assignment
  before any smaller counterexample was found

## CLI

```
python -m cegen find spec.json --bound 6 [--max-len L] [--max-enumerated N]
```

Outputs `{"status", "counterexample", "stats"}` as JSON on stdout.
Spec/usage errors raise `PolicyError` and exit with code 2.

## Tests

```
python -m unittest discover -s tests -v
```

Includes a randomized differential suite (1000 specs, fixed seed) comparing
status and minimality against an independent `itertools.product` reference.
