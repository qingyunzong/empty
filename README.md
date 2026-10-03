# ridag — exact rational interval DAGs and certified root isolation

`ridag` answers numerical questions with *provable* intervals instead of
plausible-looking floats.  All arithmetic is exact rational
(`fractions.Fraction`) with open/closed and infinite endpoints; every root
claim ships with a machine-checkable certificate that an independent
checker re-derives from scratch.

Pure Python 3.11 standard library.  No dependencies.

## Features

- **Expression DAG** (`ridag.dag`): hash-consed nodes (structural sharing
  of common subexpressions), constant folding and cancellation
  (`x - x -> 0`), symbolic differentiation, integer powers, and `cond`
  sign-branch nodes.
- **Exact interval arithmetic** (`ridag.interval`): rational endpoints
  with open/closed flags and signed infinities.  Division by an interval
  straddling zero splits into a canonical *union* of rays — structure is
  never collapsed into the whole real line.
- **Cached evaluator** (`ridag.evaluator`): results are cached per node
  with (variable -> version) dependency stamps; shrinking or rolling back
  a variable interval invalidates exactly its dependents.
- **Root isolation** (`ridag.newton`): interval Newton plus monotone
  contraction and bisection over the DAG, using symbolic derivatives and
  exact interval evaluation.  Every output box is tagged
  `unique_root` / `no_root` / `undecided`; when the budget runs out the
  remaining boxes are emitted as `undecided`, never dropped.  Zeros of
  denominators are treated as domain holes (located exactly via the
  rational root theorem when rational, confined below `eps` otherwise).
- **Certificate checker** (`ridag.cert`): independently rebuilds the DAG,
  re-evaluates every enclosure, replays every contraction step
  (inclusion check), verifies uniqueness conditions (monotone + sign
  change, exact point roots, Sturm count 1) and verifies that claims plus
  certified exclusions cover the domain.
- **Sturm cross-check** (`ridag.poly`): exact Sturm sequences over
  rational polynomials, used both by the isolator (small-box decisions)
  and by the test suite as an independent root counter.
- **JSON CLI** (`python3.11 -m ridag`): `solve`, `eval`, `verify`
  subcommands; certificates serialize to JSON for save/restore.

## CLI

```sh
# isolate roots of x^2 - 2 on [-10, 10]
echo '{"expression": {"sub": [{"pow": [{"var": "x"}, 2]}, {"const": 2}]},
       "domain": {"lo": "-10", "hi": "10"}}' \
  | python3.11 -m ridag solve

# interval-evaluate an expression
echo '{"expression": {"div": [{"const": 1}, {"var": "x"}]},
       "env": {"x": {"lo": "-1", "hi": "1"}}}' \
  | python3.11 -m ridag eval

# independently verify a saved certificate
python3.11 -m ridag verify cert.json
```

Expression JSON: `{"const": "3/4"}`, `{"var": "x"}`,
`{"add": [a, b]}`, `{"sub": ...}`, `{"mul": ...}`, `{"div": ...}`,
`{"neg": a}`, `{"pow": [a, n]}`, `{"cond": [test, then, else]}`
(branch on `test >= 0`).  Intervals:
`{"lo": "-1/2", "lo_open": true, "hi": "+inf", "hi_open": true}`.

## Library sketch

```python
from fractions import Fraction
from ridag import DAG, Isolator, Interval, IntervalUnion, End, verify_certificate
from ridag.jsonio import cert_to_json

dag = DAG()
x = dag.var("x")
f = dag.div(dag.sub(x, 1), dag.sub(x, 3))          # (x-1)/(x-3)
dom = IntervalUnion([Interval.closed(End(-10), End(10))])
cert = Isolator(dag, f, "x", dom).isolate()
for c in cert.claims:
    print(c.status, c.interval)
ok, errors = verify_certificate(cert_to_json(cert))
```

## Tests

```sh
python3.11 -m unittest discover -s tests -v
```

Covers: known rational roots, multiple roots, cancellation/dependency
over-estimation, roots touching open endpoints, tiny fractions
(`1/10^18`), domain holes, unbounded domains (Cauchy clamp), budget
exhaustion (undecided preserved), certificate tampering, save/restore,
and randomized low-degree polynomials cross-checked against independent
Sturm counts.
