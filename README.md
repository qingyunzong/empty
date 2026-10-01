# exactcalc — exact integer roots and algebraic-number rounding

Pure Python 3.11 standard library. No floating point is ever used to
decide a boundary: every answer is settled by exact integer/rational
arithmetic and comes with independently checkable evidence.

## Layout

- `exactcalc/introot.py` — integer k-th root floor with verifiable
  comparison evidence. `pow_cap(base, exp, cap)` is a truncated power:
  it saturates at `±(cap+1)`, so comparing `r**k` against `n` never
  materializes intermediates larger than `~(|n|+1)^2`, however large the
  true power would be. `root_evidence(n, k)` returns `{"n","k","r"}` and
  `verify_root_evidence(ev)` re-checks `r**k <= n < (r+1)**k` exactly;
  any tampering is rejected. Negative inputs use the real odd-root
  definition (`k` odd); even roots of negatives raise `ValueError`.
- `exactcalc/polys.py` — exact polynomial tools over Q: squarefree
  normalization, polynomial gcd, Sturm sequences and root counting,
  real-root isolation, exact sign evaluation at rationals (integer-only
  arithmetic), and rational floor/ceil/round-half-even helpers.
- `exactcalc/algebraic.py` — `AlgebraicNumber`: a squarefree integer
  polynomial plus a rational isolating interval containing exactly one
  root (Sturm-verified at construction, so forged specs are rejected).
  Provides `floor`, `ceil`, `round_half_even`, `compare`,
  `compare_to_rational`, `scale(p, q)` and `scaled_round`. When an
  interval straddles an integer or half-integer, the answer is settled
  by bisection refinement or exact sign evaluation — never by
  approximation. `budget` only caps how many bisection steps are tried
  before falling back to exact sign determination; `budget=0` is still
  exact. Equality of different polynomial representations of the same
  number is decided via polynomial gcd + Sturm root counts.
- `exactcalc/cache.py` — `EvidenceCache`: caches isolation evidence and
  rounding results; `save`/`load` implement checkpointing. Every entry
  is fully re-verified on restore (canonical squarefree form, Sturm
  count == 1, interval containment, result consistency); tampered
  checkpoints raise `EvidenceError`. Cached results are self-certifying:
  numbers are refined until the interval alone proves the result.
- `exactcalc/cli.py` — JSON CLI (`python3.11 -m exactcalc`).

## Library usage

```python
from exactcalc import (
    int_kth_root_floor, root_evidence, verify_root_evidence,
    AlgebraicNumber, EvidenceCache,
)

r = int_kth_root_floor(10**40, 7)
ev = root_evidence(10**40, 7)          # {"n": ..., "k": 7, "r": ...}
assert verify_root_evidence(ev)

sqrt2 = AlgebraicNumber([-2, 0, 1], 1, 2)   # x^2 - 2 on (1, 2)
sqrt2.floor(); sqrt2.ceil(); sqrt2.round_half_even()
sqrt2.floor(budget=0)                       # still exact
sqrt2.scaled_round(3, 2)                    # round((3/2)*sqrt2) == 2

other = AlgebraicNumber([6, 0, -5, 0, 1], 1, "3/2")  # sqrt2 again
assert sqrt2.compare(other) == 0

cache = EvidenceCache()
a = AlgebraicNumber([-2, 0, 1], 1, 2, cache=cache)
a.floor()
cache.save("checkpoint.json")
restored = EvidenceCache.load("checkpoint.json")  # verifies everything
```

## JSON CLI

Reads one JSON request from a file argument or stdin, writes JSON to
stdout. Rationals are `"num/den"` strings; big integers may be strings.

```sh
echo '{"cmd":"int_root","n":"10000000000000000000000000000","k":7}' | python3.11 -m exactcalc
# {"ok": true, "r": 10000, "evidence": {"n": ..., "k": 7, "r": 10000}}

echo '{"cmd":"verify_root","evidence":{"n":1000,"k":3,"r":10}}' | python3.11 -m exactcalc
# {"ok": true, "valid": true}

echo '{"cmd":"floor","poly":[-2,0,1],"lo":"1","hi":"2","budget":0}' | python3.11 -m exactcalc
# {"ok": true, "result": 1}

echo '{"cmd":"round","poly":[-2,0,1],"lo":"1","hi":"2","scale":["3","2"]}' | python3.11 -m exactcalc
# {"ok": true, "result": 2}

echo '{"cmd":"compare","a":{"poly":[-2,0,1],"lo":"1","hi":"2"},"b":{"exact":"3/2"}}' | python3.11 -m exactcalc
# {"ok": true, "result": -1}

echo '{"cmd":"isolate","poly":[0,-2,0,1]}' | python3.11 -m exactcalc
# roots of x^3 - 2x: intervals around -sqrt2, exact 0, sqrt2
```

Any request may include `"cache_file": "path.json"`: the evidence cache
is loaded (and verified) before the command runs and saved afterwards,
giving checkpoint/resume across CLI invocations. A corrupted or tampered
cache file makes the command fail with an `EvidenceError`.

## Tests

```sh
python3.11 -m unittest discover -s tests -v
```

Coverage includes: huge inputs constructed exactly at/around integer
powers (`m**k ± 1`), polynomials with multiple roots, repeated factors
(non-squarefree input), the same algebraic number under different
polynomial representations, round-half-even ties (including negative
half-integers), `budget=0` exactness, exhaustive cross-checks of decimal
rounding against an independent rational reference implementation,
truncated-power saturation, and rejection of tampered root evidence and
tampered checkpoints.

Last recorded run (Python 3.11.16): **47 tests, OK** (see below).

```
Ran 47 tests in ~5s

OK
```
