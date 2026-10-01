# csp_arith

Offline integer binary arithmetic constraint propagation with lazy
explanation generation. Pure Python 3.11+ standard library, no external
resources, no pregenerated allowed-value tuples: every support check is
computed on the fly from the current domains.

## Usage

```
python -m csp_arith explain --input <problem.json>
```

(Use `python3` if `python` is not on your PATH.)

## Input format

```json
{
  "variables": {"x": [1, 2, 3], "y": [2, 3]},
  "constraints": [
    {"type": "lt", "vars": ["x", "y"]}
  ]
}
```

* `variables`: object mapping each variable name to its enumerated
  domain (a non-empty list of integers; booleans are rejected).
* `constraints`: list of binary constraints; `type` is one of
  `lt` (`<`), `le` (`<=`), `eq` (`=`), `ne` (`!=`); `vars` holds the
  two variable names in order.

Invalid input (unknown constraint type, reference to a non-existent
variable, non-integer domain value, malformed JSON, missing file)
prints a JSON `{"error": ...}` message to stderr and exits with a
non-zero status code (2).

## Output format

```json
{
  "status": "consistent",
  "domains": {"x": [1, 2], "y": [2, 3]},
  "explanations": [
    {
      "variable": "x",
      "value": 3,
      "constraint": "lt",
      "vars": ["x", "y"],
      "premise": {"max": 3}
    }
  ]
}
```

* `status`: `consistent` or `inconsistent`.
* `domains`: the arc-consistent domains after propagation.
* `explanations`: one minimal explanation per pruned value, containing
  only the direct premise that triggered the removal:
  * `lt` / `le` forward: `{"max": m}` (max of the other domain)
  * `lt` / `le` reversed: `{"min": m}` (min of the other domain)
  * `eq`: `{"domain": [...]}` (other domain, which lacks the value)
  * `ne`: `{"domain": [v]}` (other singleton domain)
* `conflict` (only when `inconsistent`): the explanation set of the
  emptied domain, accumulated up to and including its last removed
  value; directly usable as a Nogood.

Propagation computes the true arc-consistency fixpoint and produces
exactly the same domains as a textbook AC-3 that pregenerates all
allowed value pairs (verified by differential tests).

## Tests

```
python -m unittest discover -v
```

The suite includes a naive reference implementation
(`tests/reference.py`) that pregenerates all allowed value pairs per
constraint, plus a naive dependency-chain enumerator used to
cross-check conflict explanations.
