# polygcd

Modular GCD of integer polynomials with verifiable results.
Pure Python 3.11 standard library; no third-party dependencies.

Polynomials are dense coefficient lists, little-endian (`[c0, c1, ...]`
means `c0 + c1*x + ...`); the zero polynomial is `[]`.

## Library layout

- `polygcd/polynomial.py` — integer polynomial arithmetic, content /
  primitive-part decomposition, exact division over Z.
- `polygcd/modular.py` — monic GCD over GF(p), CRT coefficient
  reconstruction.
- `polygcd/rational.py` — Q[x] arithmetic, Wang rational
  reconstruction, an independent rational Euclidean GCD used to
  cross-check the modular engine.
- `polygcd/bezout.py` — extended GCD over Q producing a Bezout
  certificate `(d, s, t)` with `s*f + t*g == d`, plus an independent
  verifier that rechecks the identity and the divisibility of `f`, `g`
  by `d` from scratch.
- `polygcd/engine.py` — the modular GCD engine.
- `polygcd/cli.py` — JSON command-line interface.

## Algorithm

1. Split `f = cont(f) * pp(f)`, `g = cont(g) * pp(g)`; the integer
   content GCD is handled separately from the primitive parts.
2. For each prime `p` (ascending from 2, or `--prime-start`):
   - **Bad prime** (leading coefficient of `pp(f)` or `pp(g)` vanishes
     mod `p`): recorded and skipped.
   - Compute the monic GCD mod `p`. If its degree is *higher* than the
     current degree bound, the prime is **unlucky**: recorded and never
     mixed into the accumulated congruences. If the degree is *lower*,
     the accumulation is restarted from this prime and the previously
     accumulated primes are recorded as discarded.
3. Accumulate equal-degree modular GCDs via CRT; after each prime try
   rational reconstruction of every coefficient of the monic GCD.
4. A candidate is accepted only after **exact division** of both
   primitive parts over Z succeeds — no conclusion is ever drawn from a
   single prime, and no unverified candidate is returned.
5. Result: `gcd = content_gcd * primitive_part`, where the primitive
   part is primitive with positive leading coefficient.

## Budget and resumption

`run(budget=N)` consumes at most `N` primes. On exhaustion the result
has `status: "budget_exhausted"`, a `checkpoint` (used primes, bad /
unlucky / discarded primes, accumulated congruences) and a `pending`
list of remaining checkpoints. Resume with
`ModularGCDEngine(f, g, checkpoint=...)`; already used primes are
skipped, so no congruence is ever counted twice.

## CLI

```sh
# GCD (coefficients are JSON lists, or @file)
python3.11 -m polygcd gcd --f '[1,2,1]' --g '[1,1]'

# Bounded run, saving the checkpoint on exhaustion (exit code 1)
python3.11 -m polygcd gcd --f '[1,1,211,210,210]' --g '[1,2,2,1]' \
    --budget 2 --state-out state.json

# Resume from the checkpoint
python3.11 -m polygcd gcd --f '[1,1,211,210,210]' --g '[1,2,2,1]' \
    --resume state.json --budget 200

# Bezout certificate over Q, and independent verification
python3.11 -m polygcd bezout --f '[2,-3,1]' --g '[3,-4,1]' --cert-out cert.json
python3.11 -m polygcd verify --cert cert.json
```

All output is JSON on stdout. The `gcd` command reports the GCD, the
content / primitive-part decomposition, and full prime statistics
(used, bad, unlucky, discarded, CRT moduli).

## Tests

```sh
python3.11 -m unittest discover -s tests -v
```

Coverage includes: large content factors, repeated factors, zero
polynomials, leading coefficients vanishing under several primes,
unlucky primes and restarts, cases needing many CRT moduli, forged
Bezout certificates, stepwise budget-exhaustion/recovery, cross-checks
against an independent rational Euclidean algorithm, and a degree /
coefficient-bit-width matrix (degrees 2–20, 8–256 bits).

**Note:** the matrix test prints real timings measured on the test
machine. These are empirical observations only — no asymptotic
performance or complexity claim is made or has been verified.
