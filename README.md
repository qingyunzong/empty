# bmc — bounded model checker

A small bounded model checker for integer transition systems, plus a CLI.
Python 3.11+, standard library only.

## Usage

```
python -m bmc check model.json --bound 12 --out trace.json
```

Exit codes: `0` analysis completed (`SAFE_BOUNDED` or `VIOLATION`),
`1` runtime evaluation error (e.g. `E_READ`), `2` invalid model
(one-line JSON is printed to stderr).

## Model format

```json
{
  "variables": ["x", "y"],
  "init": {"x": 0, "y": 0},
  "transitions": [
    {"name": "inc", "guard": "x < 3", "assign": {"x": "x + 1"}}
  ],
  "invariant": "x + y <= 9"
}
```

- At most 6 variables and 40 transitions; values stay in `[-9, 9]`.
- Guards, assignments and the invariant are expression strings supporting
  `+ - * // %`, comparisons, `and`/`or`/`not`, and `true`/`false`.
- Assignments in one transition are evaluated simultaneously against the
  pre-state.

## Semantics

- States are normalized as `(name, value)` pairs sorted by variable name;
  reading an undefined variable raises error `E_READ`.
- A transition is enabled only if its guard holds and every assigned
  value remains in the domain; otherwise it is disabled (not an error).
- Exploration is BFS by layer; the first state violating the invariant
  yields the shortest counterexample.
- Reaching the bound without a violation reports `SAFE_BOUNDED`
  (bounded only, not a global safety proof).
- A state already visited is never enqueued again.

## Output

JSON with `status` (`SAFE_BOUNDED` / `VIOLATION` / `ERROR`), `depth`,
`visited`, `trace` (list of states), `counterexample` (transition names)
and `error`.

## Tests

```
python -m unittest discover -s tests -v
```
