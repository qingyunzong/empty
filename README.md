# csp_arith

Offline, standard-library-only constraint propagation library for integer
binary arithmetic constraints (`lt` / `le` / `eq` / `ne`) with lazily
generated minimal removal explanations.  Allowed value pairs are never
pre-generated; every support check is computed on the fly from the
current domains.

## Usage

```
python -m csp_arith explain --input problem.json
```

Input JSON:

```json
{
  "variables": {"x": [1, 2, 3], "y": [2, 3]},
  "constraints": [{"type": "lt", "vars": ["x", "y"]}]
}
```

Output JSON fields:

- `status`: `sat` if no domain is empty after propagation, else `unsat`
- `domains`: reduced domains after arc-consistency propagation
- `explanations`: per variable, one entry per removed value; each entry
  contains only the direct premises of the removal (constraint type and
  the other domain's bound/value), e.g. `{"var": "x", "value": 3,
  "constraint": "lt", "constraint_id": 0, "other_var": "y",
  "premise": {"var": "y", "max": 3}}`
- `conflict`: when a domain is emptied, the explanations of the last
  value-removal event (usable directly as a Nogood); `null` otherwise

Exit codes: `0` on success; `2` on invalid input (unknown constraint
type, reference to an unknown variable, non-integer domain values,
malformed JSON, unreadable file).

## Tests

```
python -m unittest discover -v
```

The test suite cross-checks propagation results against a naive AC-3
reference implementation that pre-generates all allowed value pairs
(`tests/reference.py`), and conflict explanations against a naive
propagator that enumerates every dependency chain by brute force.
