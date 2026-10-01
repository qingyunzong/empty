# csp_explain — 1-UIP conflict explanation for backtracking search

Offline, standard-library-only Python 3.11+ tool that generates a first
unique implication point (1-UIP) conflict explanation clause and backjump
level from a JSON conflict record produced by a backtracking CSP solver with
implication (propagation) logging.

## Usage

```
python -m csp_explain generate --input <conflict-record.json> [--output <out.json>]
```

Output (JSON on stdout or in `--output`):

```json
{
  "clause": [{"variable": "z", "value": 1, "kind": "removed", "level": 2}, ...],
  "backjump_level": 1,
  "unsatisfiable": false
}
```

The clause is the disjunction of the negations of the listed premises: it
asserts that these assignment (`"assigned"`) / value-removal (`"removed"`)
assertions cannot all hold simultaneously. `backjump_level` is the highest
level in the clause below the conflict level (0 if the clause is asserting);
the search should jump directly to that level instead of chronological
backtracking. A conflict caused entirely by level-0 propagation yields
`"clause": []`, `"backjump_level": -1`, `"unsatisfiable": true`.

Exit codes: `0` on success, `2` on any error (unreadable/invalid JSON file,
implication records referencing unknown variables/decisions/removals, missing
conflict state, cyclic implication log, ...). Errors are reported as
`{"error": ...}` on stderr.

## Input format

```json
{
  "decisions":    [{"variable": "x", "value": 1, "level": 1}],
  "implications": [{"variable": "y", "value": 2, "level": 1,
                    "constraint": "c_xy",
                    "antecedents": [{"variable": "x", "value": 1, "kind": "assigned"}]}],
  "conflict":     {"variable": "z", "level": 2,
                   "antecedents": [{"variable": "z", "value": 1, "kind": "removed"}]}
}
```

Each implication-graph node is one value removal (or, for decisions, one
assignment); edges run from antecedents to the implied removal. `kind` in an
antecedent may be omitted when it can be inferred unambiguously.

## Layout

- `csp_explain/model.py` — parsing and validation of conflict records
- `csp_explain/uip.py` — resolver-based 1-UIP explanation generation
- `csp_explain/reference.py` — naive enumeration of all implication-graph
  cuts, filtering 1-UIP cuts (independent cross-check used by the tests)
- `csp_explain/cli.py` — command line interface
- `examples/` — sample conflict records
- `tests/` — unittest suite (`python -m unittest discover -v`)
