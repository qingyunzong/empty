"""Certified modular GCD over ZZ[x].

Algorithm: content/primitive-part decomposition, monic GCD modulo a
deterministic stream of primes, incremental CRT (Garner), and rational
reconstruction of the monic GCD over QQ.  Every candidate is verified by
exact division in ZZ[x] before being accepted, so the result is never
trusted from a single prime.

Prime classification:
  * "leading" bad primes divide a leading coefficient (the polynomial
    degenerates mod p) -- rejected before any modular work;
  * "unlucky" primes yield a modular GCD degree above the best degree
    seen so far -- discarded, never mixed into the CRT accumulation;
  * if a strictly smaller degree appears, the accumulation restarts from
    scratch (all previously accumulated primes were unlucky).

Budget: one unit per modular GCD evaluation.  On exhaustion the current
modular state (CRT residues, modulus, prime lists) and the pending
checkpoints are returned; passing the state back resumes without
re-using or re-counting any prime.
"""

from dataclasses import dataclass, field
from math import gcd as _igcd

from . import poly
from .modp import gcd_mod_p, prev_prime
from .reconstruct import (
    crt_combine,
    reconstruct_monic_poly,
    to_primitive_zz,
)

DEFAULT_PRIME_START = (1 << 61) - 1  # Mersenne prime 2**61 - 1

PENDING_CHECKPOINTS = [
    "crt_combine",
    "rational_reconstruction",
    "exact_division_verification",
]


class BudgetExhausted(Exception):
    """Raised by :func:`gcd_modular` when ``raise_on_budget`` is set."""

    def __init__(self, result):
        super().__init__("prime budget exhausted before verification")
        self.result = result


@dataclass
class GCDResult:
    status: str                      # "ok" | "budget_exhausted"
    gcd: list | None = None          # primitive, positive LC (status "ok")
    content_gcd: int = 0             # gcd of the two contents
    primes_used: list = field(default_factory=list)
    bad_primes: dict = field(
        default_factory=lambda: {"leading_coefficient": [], "unlucky": []}
    )
    modulus: int = 0                 # product of accumulated good primes
    best_degree: int = -1
    checks: dict = field(default_factory=dict)
    state: dict | None = None        # checkpoint, when budget_exhausted
    pending: list = field(default_factory=list)


def _zero_cases(f, g):
    """Handle zero/constant inputs; returns a GCDResult or None."""
    if not f and not g:
        raise ValueError("gcd(0, 0) is undefined")
    if not f:
        return poly.normalize_primitive(g)
    if not g:
        return poly.normalize_primitive(f)
    return None


def _next_prime_stream(state_candidate, explicit, used):
    """Yield primes: explicit list first, then the default stream."""
    if explicit is not None:
        for p in explicit:
            if p not in used:
                yield p
    c = state_candidate
    while True:
        p = prev_prime(c)
        if p is None:
            return
        c = p
        if p not in used:
            yield p


def gcd_modular(f, g, budget=None, state=None, primes=None,
                raise_on_budget=False):
    """Modular GCD of integer polynomials ``f`` and ``g``.

    Parameters
    ----------
    f, g : list[int]
        Dense coefficient lists, constant term first.
    budget : int | None
        Maximum number of modular GCD evaluations in this call
        (good/unlucky primes; leading-coefficient bad primes are
        rejected for free).  On resume it is a fresh allowance, not a
        cumulative total.
    state : dict | None
        Checkpoint from a previous ``budget_exhausted`` result; resumes
        the accumulation without re-using any prime.
    primes : list[int] | None
        Explicit prime stream (mainly for tests); overrides the default
        deterministic descending stream.
    """
    f = poly.trim(list(f))
    g = poly.trim(list(g))
    trivial = _zero_cases(f, g)
    if trivial is not None:
        return GCDResult(
            status="ok",
            gcd=trivial,
            content_gcd=0,
            checks={"method": "trivial (zero polynomial input)"},
        )

    content_gcd = _igcd(poly.content(f), poly.content(g))
    F = poly.primitive_part(f)
    G = poly.primitive_part(g)
    if not F or not G:  # one input was zero; handled above, defensive
        raise ValueError("unexpected zero primitive part")
    if poly.degree(F) == 0 or poly.degree(G) == 0:
        return GCDResult(
            status="ok",
            gcd=[1],
            content_gcd=content_gcd,
            checks={"method": "trivial (constant primitive part)"},
        )

    # ---- restore or initialise the accumulation state ----------------
    residues = []          # list of (prime, monic gcd coeffs mod prime)
    crt = None             # combined residues of coefficients (no leading 1)
    modulus = 1
    best_degree = None
    primes_used = []
    bad = {"leading_coefficient": [], "unlucky": []}
    spent = 0               # cumulative, restored from state
    spent_this_call = 0     # budget counts this call's work only
    prime_candidate = DEFAULT_PRIME_START

    if state is not None:
        if poly.parse(state["F"]) != F or poly.parse(state["G"]) != G:
            raise ValueError("resume state does not match input polynomials")
        residues = [(p, [int(c) for c in cs]) for p, cs in state["residues"]]
        crt = [int(c) for c in state["crt"]] if state["crt"] else None
        modulus = int(state["modulus"])
        best_degree = state["best_degree"]
        primes_used = [int(p) for p in state["primes_used"]]
        bad["leading_coefficient"] = list(state["bad_primes"]["leading_coefficient"])
        bad["unlucky"] = list(state["bad_primes"]["unlucky"])
        spent = int(state["spent"])
        prime_candidate = int(state["prime_candidate"])

    used_set = set(primes_used)
    stream = _next_prime_stream(prime_candidate, primes, used_set)

    def checkpoint():
        return {
            "F": poly.render(F),
            "G": poly.render(G),
            "content_gcd": str(content_gcd),
            "residues": [[p, [str(c) for c in cs]] for p, cs in residues],
            "crt": [str(c) for c in crt] if crt else [],
            "modulus": str(modulus),
            "best_degree": best_degree,
            "primes_used": [str(p) for p in primes_used],
            "bad_primes": {
                "leading_coefficient": [str(p) for p in bad["leading_coefficient"]],
                "unlucky": [str(p) for p in bad["unlucky"]],
            },
            "spent": spent,
            "prime_candidate": str(prime_candidate),
        }

    def exhausted():
        result = GCDResult(
            status="budget_exhausted",
            content_gcd=content_gcd,
            primes_used=list(primes_used),
            bad_primes={k: list(v) for k, v in bad.items()},
            modulus=modulus,
            best_degree=best_degree if best_degree is not None else -1,
            state=checkpoint(),
            pending=list(PENDING_CHECKPOINTS),
        )
        if raise_on_budget:
            raise BudgetExhausted(result)
        return result

    lc_f, lc_g = poly.lc(F), poly.lc(G)

    for p in stream:
        if budget is not None and spent_this_call >= budget:
            return exhausted()
        if lc_f % p == 0 or lc_g % p == 0:
            bad["leading_coefficient"].append(p)
            continue
        spent += 1
        spent_this_call += 1
        prime_candidate = p  # resume strictly below the last drawn prime
        e = gcd_mod_p(F, G, p)
        deg_e = poly.degree(e)

        if best_degree is None or deg_e < best_degree:
            if best_degree is not None:
                # previously accumulated primes were unlucky: restart
                bad["unlucky"].extend(primes_used)
            residues = [(p, e)]
            crt = list(e[:-1])
            modulus = p
            best_degree = deg_e
            primes_used = [p]
            used_set.add(p)
        elif deg_e > best_degree:
            bad["unlucky"].append(p)
            continue
        else:
            for i, c in enumerate(e[:-1]):
                crt[i], modulus_i = crt_combine(crt[i], modulus, c, p)
                assert modulus_i == modulus * p
            modulus *= p
            residues.append((p, e))
            primes_used.append(p)
            used_set.add(p)

        # ---- candidate reconstruction + exact verification -----------
        monic_candidate = reconstruct_monic_poly(crt, modulus)
        if monic_candidate is None:
            continue
        d = to_primitive_zz(monic_candidate)
        if poly.degree(d) != best_degree:
            continue
        qf = poly.div_exact_zz(F, d)
        if qf is None:
            continue
        qg = poly.div_exact_zz(G, d)
        if qg is None:
            continue
        return GCDResult(
            status="ok",
            gcd=d,
            content_gcd=content_gcd,
            primes_used=list(primes_used),
            bad_primes={k: list(v) for k, v in bad.items()},
            modulus=modulus,
            best_degree=best_degree,
            checks={
                "exact_division_f": poly.render(qf),
                "exact_division_g": poly.render(qg),
                "modular_degree_matches": True,
                "primes_in_crt": len(primes_used),
            },
        )
    raise RuntimeError("prime stream exhausted before verification")


def gcd_with_bezout(f, g, **kw):
    """GCD plus a rational Bezout certificate (see :mod:`polygcd.bezout`)."""
    from .bezout import bezout_certificate

    result = gcd_modular(f, g, **kw)
    certificate = None
    if result.status == "ok":
        certificate = bezout_certificate(f, g, result.gcd)
    return result, certificate
