# ridag — rational interval expression DAGs with certified root isolation

Pure Python 3.11 (standard library only).  All arithmetic is exact
(`fractions.Fraction`); results are provable interval statements, not
floating-point guesses.

## Features

- **Expression DAG** (`ridag.expr`): `const`, `var`, `add`, `sub`, `mul`,
  `div`, integer `pow`, and conditional `if` (sign-based branch).  Nodes
  are hash-consed, so common subexpressions are physically shared.
- **Exact interval arithmetic** (`ridag.intervals`): rational endpoints
  with independent open/closed flags and `+/-inf`.  Division by an
  interval containing zero splits into a canonical union of rays
  (e.g. `1/[-1,1] = (-inf,-1] ∪ [1,inf)`), never the whole real line;
  denominator zeros are tracked as domain holes.
- **Evaluation environment** (`ridag.expr.Env`): per-variable version
  counters; the evaluation cache is invalidated exactly along node
  dependencies when a variable interval shrinks or is rolled back via
  `save()`/`restore()`.
- **Root isolation** (`ridag.isolate`): symbolic derivatives plus exact
  interval evaluation; combines endpoint sign rules, interval Newton
  contraction and bisection.  Every output interval is labelled
  `unique` / `none` / `undecided`; budget exhaustion keeps `undecided`
  outputs — they are never dropped.
- **Independent certificate checker** (`ridag.certcheck`): a separate
  implementation of interval arithmetic and evaluation that re-verifies
  every contraction's inclusion chain and the uniqueness/emptiness
  conditions of each output.
- **Sturm cross-check** (`ridag.sturm`): exact distinct-root counting
  used by the test-suite to verify coverage (no root missed, each
  `unique` interval contains exactly one root).

## JSON CLI

```
python3.11 -m ridag spec.json        # or pipe JSON to stdin
```

Spec:

```json
{
  "expression": {"op": "sub", "args": [{"op": "var", "name": "x"},
                                       {"op": "const", "value": "1"}]},
  "variables":  {"x": [["-2", "2", true, true]]},
  "evaluate":   true,
  "isolate":    {"var": "x", "budget": 1000},
  "verify":     true
}
```

- bounds: `"p/q"` strings, `"inf"` / `"-inf"`; a variable maps to a list
  of `[lo, hi, lo_closed, hi_closed]` intervals (a union);
- expression ops: `const` (`value`), `var` (`name`), `add`/`sub`/`mul`/
  `div` (`args`: pair), `pow` (`arg`, integer `exp`), `if` (`cond`,
  `then`, `else`).

Output contains evaluated range (`value`, `hole`) and/or isolation
`outputs` with `certificates`; with `verify` every certificate is
checked by the independent checker and `verification: "ok"` is emitted.

## Tests

```
python3.11 -m unittest discover -s tests -v
```

Covers: exact interval arithmetic (open/closed, infinities, division
splitting), DAG sharing and dependency-based cache invalidation,
save/restore, conditional branches, symbolic derivatives, known rational
roots, multiple roots, cancellation-induced dependency over-estimation,
roots next to open endpoints, tiny fractions, domain holes, certificate
tampering, CLI, and Sturm cross-checks of root coverage for low-degree
polynomials.
