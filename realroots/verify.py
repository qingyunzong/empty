"""Independent verifier for isolation certificates.

Recomputes everything from the certificate's claims: the squarefree
factorization relation, squarefreeness and coprimality of factors, the
Sturm sequences, per-interval sign variation counts, disjointness and
ordering of the isolating intervals, and coverage (every real root of
every factor is accounted for).
"""

from . import poly as P
from .jsonutil import dec_frac, dec_poly
from .sturm import (sign_variations_at, sign_variations_at_infinity,
                    sturm_sequence)


def verify_certificate(cert):
    """Return (ok, checks) where checks lists each named verification step."""
    checks = []

    def check(name, ok, detail=""):
        checks.append({"check": name, "ok": bool(ok), "detail": detail})
        return bool(ok)

    try:
        f = dec_poly(cert["polynomial"])
        claimed_lc = dec_frac(cert["leading_coefficient"])
        entries = cert["squarefree_factors"]
        factors = [(dec_poly(e["factor"]), e["multiplicity"]) for e in entries]
        roots = cert["roots"]
        eps = dec_frac(cert["eps"]) if cert.get("eps") is not None else None
    except (KeyError, ValueError, TypeError) as exc:
        check("parse", False, str(exc))
        return False, checks

    ok = check("parse", True)

    # 1. Squarefree factorization relation: lc * prod(factor^mult) == f.
    product = (claimed_lc,)
    for factor, mult in factors:
        product = P.mul(product, P.pow_poly(factor, mult))
    ok &= check("squarefree_relation", product == f)

    # 2. Factors are monic, nonconstant, squarefree, pairwise coprime.
    monic_ok = all(not P.is_constant(fa) and P.is_one((P.leading_coeff(fa),))
                   for fa, _ in factors)
    ok &= check("factors_monic_nonconstant", monic_ok)
    sf_ok = all(P.is_constant(P.gcd(fa, P.deriv(fa))) for fa, _ in factors)
    ok &= check("factors_squarefree", sf_ok)
    coprime_ok = all(
        P.is_constant(P.gcd(factors[i][0], factors[j][0]))
        for i in range(len(factors)) for j in range(i + 1, len(factors))
    )
    ok &= check("factors_pairwise_coprime", coprime_ok)

    # 3. Sturm sequences match recomputation from each factor.
    sturms = []
    sturm_ok = True
    for (fa, _), entry in zip(factors, entries):
        recomputed = sturm_sequence(fa)
        sturms.append(recomputed)
        claimed = [dec_poly(s) for s in entry["sturm"]]
        if claimed != list(recomputed):
            sturm_ok = False
    ok &= check("sturm_sequences", sturm_ok)

    # 4. Claimed total real-root counts match variations at +-infinity.
    totals_ok = True
    totals = []
    for entry, st in zip(entries, sturms):
        total = (sign_variations_at_infinity(st, -1)
                 - sign_variations_at_infinity(st, +1))
        totals.append(total)
        if entry["total_real_roots"] != total:
            totals_ok = False
    ok &= check("total_real_roots", totals_ok)

    # 5. Each claimed root is valid.
    roots_ok = True
    per_factor = [0] * len(factors)
    prev_hi = None
    for entry in roots:
        idx = entry.get("factor")
        if not isinstance(idx, int) or not (0 <= idx < len(factors)):
            roots_ok = False
            continue
        fa, mult = factors[idx]
        st = sturms[idx]
        per_factor[idx] += 1
        if entry.get("multiplicity") != mult:
            roots_ok = False
        if entry["kind"] == "point":
            value = dec_frac(entry["value"])
            lo = hi = value
            if P.evaluate(fa, value) != 0:
                roots_ok = False
        elif entry["kind"] == "interval":
            lo, hi = dec_frac(entry["lo"]), dec_frac(entry["hi"])
            if not lo < hi:
                roots_ok = False
            if P.evaluate(fa, lo) == 0 or P.evaluate(fa, hi) == 0:
                roots_ok = False  # endpoints must not be roots
            v_lo = sign_variations_at(st, lo)
            v_hi = sign_variations_at(st, hi)
            if entry.get("sign_variations_lo") != v_lo:
                roots_ok = False
            if entry.get("sign_variations_hi") != v_hi:
                roots_ok = False
            if v_lo - v_hi != 1:
                roots_ok = False  # exactly one root inside
            if eps is not None and hi - lo > eps:
                roots_ok = False
        else:
            roots_ok = False
            continue
        if prev_hi is not None and not prev_hi < lo:
            roots_ok = False  # strict separation and sorted order
        prev_hi = hi
    ok &= check("roots_valid_separated", roots_ok)

    # 6. Coverage: every real root of every factor is isolated.
    coverage_ok = all(count == total for count, total in zip(per_factor, totals))
    ok &= check("coverage", coverage_ok)

    return bool(ok), checks
