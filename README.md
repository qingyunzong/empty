# exactnum — exact integer roots and algebraic-number rounding

Pure Python 3.11 standard library. No floating point is ever used to decide
a boundary: every comparison is exact integer/rational arithmetic.

## Library

- `exactnum.integer_kth_root(n, k)` — floor k-th root of a (possibly huge)
  integer, returning an `IntRootEvidence` record with `r**k` and `(r+1)**k`
  so anyone can re-verify `r**k <= n < (r+1)**k`. Power comparisons during
  the search use upper-bound truncation (`capped_pow_leq`), so no uselessly
  large intermediate powers are formed. Odd `k` supports negative `n`.
  `verify_introot_evidence(ev)` re-checks a record; tampering is rejected.
- `exactnum.AlgebraicNumber(coeffs, lo, hi)` — a real algebraic number given
  by a rational polynomial (coefficients ascending) and a rational interval
  isolating exactly one real root (verified with Sturm's theorem; multiple
  roots are handled by square-free reduction). Exact operations:
  - `floor()`, `ceil()`, `round_half_even()` — decided by interval
    refinement plus exact sign evaluation at integers/half-integers.
  - `compare(other)` — exact three-way comparison of two algebraic numbers
    (equal numbers with different polynomial representations compare equal).
  - `scale(p/q)` — exact rescaling by a rational factor before rounding.
  - `kth_root(n, k)`, `from_rational(q)`, `from_decimal("3.14")`.
  - Every operation accepts a refinement `budget`; exhausting it raises
    `RefinementBudgetExhausted` instead of answering approximately.
- `exactnum.EvidenceCache` — caches refined isolating intervals; `save()` /
  `load()` implement JSON checkpoints. Every entry is re-validated on load
  and on adoption (containment + strict sign change, or exact root for point
  intervals); tampered checkpoints raise `EvidenceError`.

## JSON CLI

    echo '{"op": "introot", "n": "1000000000000000000000", "k": 3}' | python3.11 -m exactnum
    echo '{"op": "floor", "alg": {"poly": ["-2", "0", "1"], "interval": ["1", "2"]}}' | python3.11 -m exactnum
    echo '{"op": "round_even", "alg": {...}, "scale": "3/7", "budget": 100}' | python3.11 -m exactnum
    echo '{"op": "compare", "a": {...}, "b": {...}}' | python3.11 -m exactnum
    echo '{"op": "verify_introot", "evidence": {...}}' | python3.11 -m exactnum

`--checkpoint FILE` resumes a saved evidence cache, `--save-checkpoint FILE`
writes one after the request. Budget exhaustion yields
`{"error": "budget_exhausted"}`; invalid evidence exits non-zero.

## Tests

    python3.11 -m unittest discover -s tests -v

Covers: huge boundary inputs constructed by integer powers (exact / ±1),
multiple roots, identical numbers with different polynomial representations,
round-half-even ties, negative half-integers, zero budgets, exhaustive
decimal sweeps cross-checked against independent Fraction arithmetic, and
rejection of tampered integer-root evidence and tampered checkpoints.

Last recorded run: 49 tests, all OK (see below).
