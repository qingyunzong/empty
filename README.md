# realroots — exact real-root isolation over the rationals

Pure Python 3.11 (standard library only). All arithmetic is exact rational
arithmetic (`fractions.Fraction`); no floating point and no numerical
root-finding libraries are used anywhere.

## Features

- **Squarefree factorization** (Yun's algorithm) of rational polynomials,
  giving each real root its exact multiplicity.
- **Sturm sequences** for exact root counting in open rational intervals.
- **Root isolation** into pairwise non-overlapping rational intervals,
  with rational roots reported exactly as points.
- **Refinement** of any isolating interval to a prescribed rational error.
- **Comparison** of algebraic numbers coming from different polynomials,
  decided by polynomial GCD and joint isolation (never by interval
  midpoints).
- **Budgeted, resumable isolation**: a run limited by an operation budget
  saves its frontier and can be resumed later with no repeated or missed
  roots.
- **Certificates** (squarefree factor relation, Sturm sequences, endpoint
  sign-variation counts, coverage) checked by an independent verifier.
- **JSON CLI**: `python3.11 -m realroots.cli` (request from stdin or a
  file argument, response on stdout).

## Conventions

- Polynomials are coefficient lists, lowest degree first: `[-2, 0, 1]`
  means `x^2 - 2`. Rationals are JSON integers or `"p/q"` strings; floats
  are rejected to preserve exactness.
- A root is reported as:
  - `{"kind": "point", "value": "r"}` — `r` is rational and is exactly a
    root (this includes roots that happen to land on a bisection point);
  - `{"kind": "interval", "lo": "a", "hi": "b"}` — the root lies in the
    **open** interval `(a, b)`; `a`, `b` are rational and are *not* roots.
  Point roots are the closed degenerate case `[r, r]`; interval roots are
  always open at both ends, so endpoints that are roots are always
  represented separately as points.
- After finalization roots are sorted and **strictly separated**:
  `roots[k].hi < roots[k+1].lo` — isolating intervals never overlap.
- Each root carries its `multiplicity` from the squarefree factorization.

## Budget semantics

One charged *operation* is either one initial Sturm root count per
squarefree factor, or one processed work item (a bisection with its Sturm
evaluations). `run(engine, max_ops)` / `"budget"` in the CLI stop as soon
as the budget is spent; the engine state (`state` in the JSON response,
including the frontier queue and `pending` count) can be serialized and
resumed later. Segmented runs produce exactly the same roots and consume
exactly the same number of operations as one continuous run.

## Library usage

```python
from fractions import Fraction
from realroots import isolate, compare, AlgebraicNumber, verify_certificate
from realroots.certificate import build_certificate

status, roots, engine = isolate([-2, 0, 1], eps=Fraction(1, 1000))
cert, roots = build_certificate([-2, 0, 1])
ok, checks = verify_certificate(cert)

a = AlgebraicNumber.from_polynomial([-2, 0, 1], "interval", 1, 2)
b = AlgebraicNumber.from_polynomial([-14, 7, 2, -7, 0, 0, 0][:4], "interval", 1, 2)
compare(a, b)  # -1, 0 or 1
```

## JSON CLI

```sh
echo '{"cmd":"isolate","polynomial":[-2,0,1],"eps":"1/1000","certificate":true}' \
  | python3.11 -m realroots.cli
```

Commands:

- `isolate` — `{cmd, polynomial, eps?, budget?, certificate?}` →
  `{status: "ok"|"budget_exhausted", roots, state, ops, pending, ...}`.
  The zero polynomial yields `status: "error"`; constants yield no roots.
- `resume` — `{cmd, state, budget?, eps?}` continues a saved frontier.
- `compare` — `{cmd, a: {polynomial, root}, b: {polynomial, root}}` →
  `relation: "less"|"equal"|"greater"` plus both multiplicities.
- `refine` — `{cmd, polynomial, root, eps}` narrows one isolating
  interval to width `<= eps`.
- `verify` — `{cmd, certificate}` independently re-checks a certificate.

## Certificate contents and verification

A certificate records the polynomial and leading coefficient, the
squarefree factors with multiplicities and their Sturm sequences, the
total real-root count per factor (sign variations at ±∞), and the sorted
root list with per-interval endpoint variation counts. The verifier
(`realroots.verify`) independently recomputes: the factorization relation
`lc * prod(factor_i^mult_i) == f`, monic/squarefree/pairwise-coprime
factors, exact Sturm sequences, `V(lo) - V(hi) == 1` per interval with
non-root endpoints, point roots by evaluation, strict separation, and
coverage (isolated roots per factor == total real roots).

## Tests

```sh
python3.11 -m unittest discover -s tests -v
```

Covers: high-multiplicity roots, roots `2^-30`/`2^-40` apart, shared
rational and irrational roots across polynomials, constant and zero
polynomials, roots exactly on bisection points, huge coefficients
(`10^40`) and huge/tiny roots (`10^±30`), segmented-budget vs continuous
equivalence, certificate tampering, and CLI end-to-end flows.
