# polygcd — certified modular GCD for integer polynomials

A Python 3.11 (standard library only) library and JSON CLI that computes
the GCD of univariate integer polynomials reliably even for very large
coefficients, and produces independently verifiable certificates.

## Method

1. **Content / primitive part** — `f = cont(f) * pp(f)`; the GCD is
   computed on the primitive parts and normalized to a primitive
   polynomial with positive leading coefficient.
2. **Modular GCD** — monic GCD over GF(p) for a deterministic stream of
   primes (default: descending from 2^61 - 1).
3. **Bad primes** —
   * *leading-coefficient* primes divide `lc(f)` or `lc(g)` and are
     rejected before any modular work;
   * *unlucky* primes give a modular GCD degree above the best degree
     seen; they are discarded and never enter the CRT accumulation;
   * if a strictly smaller degree appears, the accumulation **restarts**
     and the previously accumulated primes are reclassified as unlucky.
4. **CRT + rational reconstruction** — incremental Garner combination of
   the monic modular GCDs, then rational reconstruction of each
   coefficient (bound `sqrt(M/2)`).  A conclusion is never drawn from a
   single prime.
5. **Exact verification** — every reconstructed candidate must divide
   both primitive parts exactly in ZZ[x]; the quotients are reported in
   `checks` as witnesses.
6. **Bezout certificate** — the extended Euclidean algorithm over QQ[x]
   yields `s, t` with `s*f + t*g == d`; `verify_bezout` re-checks the
   identity, divisibility, primitivity and degree hygiene independently.
7. **Budget / checkpointing** — one budget unit per modular GCD
   evaluation.  On exhaustion the CRT residues, modulus, prime lists and
   pending checkpoints are returned; passing `state` back resumes with a
   fresh budget allowance and never re-uses or double-counts a prime.

An independent, deliberately naive Euclidean GCD over QQ[x]
(`polygcd.euclid.euclid_gcd_qq`) cross-checks the modular implementation
in the test-suite.

## Library usage

```python
from polygcd import gcd_modular, bezout_certificate, verify_bezout

r = gcd_modular([1, 2, 1], [1, 1])          # dense, constant term first
assert r.status == "ok" and r.gcd == [1, 1]

r = gcd_modular(f, g, budget=1)              # may return "budget_exhausted"
r = gcd_modular(f, g, budget=50, state=r.state)   # resume

cert = bezout_certificate(f, g, r.gcd)
assert verify_bezout(f, g, cert)
```

## JSON CLI

Reads one JSON object from stdin (or a file argument), writes JSON to
stdout.  Coefficients are decimal strings or ints, constant term first;
rationals are `"num/den"`.

```sh
echo '{"op":"gcd","f":["1","2","1"],"g":["1","1"],"include_bezout":true}' \
  | python3.11 -m polygcd
```

Operations: `gcd` (accepts `budget`, `primes`, `state`, `include_bezout`),
`verify_bezout`, `content_pp`, `euclid_gcd`.

## Tests

```sh
python3.11 -m unittest discover -s tests -v
```

Covers: contents with huge common factors, repeated factors, zero
polynomials, leading coefficients vanishing under several primes,
unlucky primes and degree-restart, reconstructions needing multiple CRT
moduli, forged Bezout certificates, stepwise budget-exhaustion/resume,
and a degree/bit-width scaling table.

**Complexity disclaimer:** the scaling test records observed wall-clock
timings for a few concrete sizes only.  No asymptotic performance or
complexity bounds have been measured or verified.
