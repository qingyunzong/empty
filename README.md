# csp_alldiff

Offline, stdlib-only AllDifferent global constraint propagation over
integer finite domains (Python 3.11+), based on maximum bipartite
matching (Regin's algorithm): Hall sets are detected via strongly
connected components and alternating paths to free values in the
oriented variable-value graph. The constraint is never decomposed into
pairwise not-equal constraints.

## CLI

```
python -m csp_alldiff propagate --input <domains.json>
```

Input: a JSON list of integer domain lists, e.g. `[[1,2],[1,2],[1,2,3]]`
(also accepts `{"num_variables": N, "domains": [...]}`).

Output (stdout): JSON with `status` (`complete` | `unsat`) and
`domains` (filtered domains, or `null` when unsat).

Errors (non-integer values, malformed input, negative `num_variables`,
unreadable file) print a JSON error to stderr and exit with code 2.

## Tests

```
python -m unittest discover -v
```

Tests compare the propagator against a brute-force GAC reference
(assignment enumeration) and against AC-3 on the pairwise not-equal
decomposition. Note: AC-3 on the decomposition is in general weaker
than GAC (e.g. `{1,2},{1,2},{1,2,3}`), so full-result comparison uses
the GAC reference; the AC-3 reference is checked on the cases where
both consistencies coincide.
