"""Modular GCD engine for integer polynomials.

Computes gcd(f, g) in Z[x] as content_gcd * primitive_gcd using prime
modular gcds, CRT and rational reconstruction.  Bad primes (where a
leading coefficient vanishes) are skipped; primes whose modular gcd
degree exceeds the current degree bound are unlucky and never mixed
into the accumulated congruences; when a smaller degree shows up the
accumulation is restarted and the discarded primes are recorded.
Every reconstructed candidate is verified by exact division over Z
before being returned.  A prime budget bounds the work; on exhaustion
a checkpoint is returned so the computation can resume from the list
of already used primes without re-counting any congruence.
"""

import math

from .polynomial import (
    trim,
    degree,
    lc,
    content_pp,
    exact_div,
    mul_scalar,
)
from .modular import gcd_mod_p, crt_polys
from .rational import rational_reconstruct, clear_denominators


def is_prime(n):
    if n < 2:
        return False
    if n % 2 == 0:
        return n == 2
    r = math.isqrt(n)
    d = 3
    while d <= r:
        if n % d == 0:
            return False
        d += 2
    return True


def prime_stream(start, skip):
    n = max(2, start)
    while True:
        if n not in skip and is_prime(n):
            yield n
        n += 1


class ModularGCDEngine:
    """Stateful, resumable modular gcd computation for two integer polys."""

    def __init__(self, f, g, prime_start=2, checkpoint=None):
        self.f = trim(f)
        self.g = trim(g)
        self.cont_f, self.pf = content_pp(self.f)
        self.cont_g, self.pg = content_pp(self.g)
        self.content_gcd = math.gcd(self.cont_f, self.cont_g)
        self.prime_start = prime_start
        if checkpoint is None:
            self.used_primes = []
            self.bad_primes = []
            self.unlucky_primes = []
            self.discarded_primes = []
            self.current_degree = None
            self.moduli = []
            self.residues = []
            self.primes_consumed = 0
        else:
            self.used_primes = [int(p) for p in checkpoint["used_primes"]]
            self.bad_primes = [int(p) for p in checkpoint["bad_primes"]]
            self.unlucky_primes = [int(p) for p in checkpoint["unlucky_primes"]]
            self.discarded_primes = [int(p) for p in checkpoint.get("discarded_primes", [])]
            self.current_degree = checkpoint["current_degree"]
            self.moduli = [int(m) for m in checkpoint["moduli"]]
            self.residues = [tuple(int(c) for c in r) for r in checkpoint["residues"]]
            self.primes_consumed = int(checkpoint["primes_consumed"])
            self.prime_start = int(checkpoint.get("prime_start", prime_start))

    def checkpoint(self):
        """Serializable state allowing exact resumption."""
        return {
            "used_primes": list(self.used_primes),
            "bad_primes": list(self.bad_primes),
            "unlucky_primes": list(self.unlucky_primes),
            "discarded_primes": list(self.discarded_primes),
            "current_degree": self.current_degree,
            "moduli": list(self.moduli),
            "residues": [list(r) for r in self.residues],
            "primes_consumed": self.primes_consumed,
            "prime_start": self.prime_start,
        }

    def _stats(self):
        return {
            "primes_consumed": self.primes_consumed,
            "used_primes": list(self.used_primes),
            "bad_primes": list(self.bad_primes),
            "unlucky_primes": list(self.unlucky_primes),
            "discarded_primes": list(self.discarded_primes),
            "moduli": list(self.moduli),
        }

    def _finish(self, pp, consumed_this_run):
        full = mul_scalar(pp, self.content_gcd) if pp else ()
        return {
            "status": "ok",
            "gcd": list(full),
            "content": self.content_gcd,
            "primitive_part": list(pp),
            "checkpoint": None,
            "pending": [],
            "consumed_this_run": consumed_this_run,
            **self._stats(),
        }

    def _pending(self, consumed_this_run):
        return {
            "status": "budget_exhausted",
            "gcd": None,
            "content": self.content_gcd,
            "primitive_part": None,
            "checkpoint": self.checkpoint(),
            "pending": [
                "consume_more_primes",
                "crt_combine",
                "rational_reconstruct",
                "exact_division_verify",
            ],
            "consumed_this_run": consumed_this_run,
            **self._stats(),
        }

    def _try_reconstruct(self):
        # Never conclude from a single prime: at least two accumulated
        # congruences are required before a candidate may be accepted
        # (the candidate is still proven by exact division afterwards).
        if len(self.moduli) < 2:
            return None
        combined, modulus = crt_polys(self.residues, self.moduli)
        coeffs = []
        for c in combined:
            r = rational_reconstruct(c, modulus)
            if r is None:
                return None
            coeffs.append(r)
        d = clear_denominators(coeffs)
        if degree(d) != self.current_degree:
            return None
        if exact_div(self.pf, d) is None:
            return None
        if exact_div(self.pg, d) is None:
            return None
        return d

    def run(self, budget=None):
        """Consume at most `budget` primes (None = unlimited)."""
        if not self.pf or not self.pg:
            # gcd(0, h) = |content(h)| * pp(h); gcd(0, 0) = 0.
            pp = self.pf if self.pf else self.pg
            return self._finish(pp, 0)
        if min(degree(self.pf), degree(self.pg)) == 0:
            return self._finish((1,), 0)

        consumed = 0
        stream = prime_stream(self.prime_start, set(self.used_primes))
        for p in stream:
            if budget is not None and consumed >= budget:
                break
            consumed += 1
            self.primes_consumed += 1
            self.used_primes.append(p)
            if lc(self.pf) % p == 0 or lc(self.pg) % p == 0:
                self.bad_primes.append(p)
                continue
            h = gcd_mod_p(self.pf, self.pg, p)
            dh = degree(h)
            if self.current_degree is None or dh < self.current_degree:
                if self.current_degree is not None:
                    self.discarded_primes.extend(self.moduli)
                self.current_degree = dh
                self.moduli = [p]
                self.residues = [h]
            elif dh == self.current_degree:
                self.moduli.append(p)
                self.residues.append(h)
            else:
                self.unlucky_primes.append(p)
                continue
            if self.current_degree == 0:
                return self._finish((1,), consumed)
            d = self._try_reconstruct()
            if d is not None:
                return self._finish(d, consumed)
        return self._pending(consumed)
