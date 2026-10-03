"""Isolation certificates and an independent verifier.

A certificate records, for a polynomial P:

* the content and the square-free factorization  P = c * prod f_i^i,
* for each factor: its Sturm sequence, a strict Cauchy bound B, and the
  sign-variation counts V(-B) and V(B),
* the isolated roots (points or open intervals) per factor.

The verifier re-checks everything from scratch using only exact rational
arithmetic: the factorization relation, square-freeness and pairwise
coprimality of the factors, the validity of each Sturm sequence, the
recorded variation counts, that every interval contains exactly one root,
that point roots are exact, and that the roots are sorted, disjoint and
cover all real roots of every factor.
"""
from __future__ import annotations

from .isolate import Root, cauchy_bound, roots_overlap
from .poly import Poly, parse_rational
from .sturm import sign_variations, sturm_sequence


def build_certificate(session):
    """Build a JSON-serializable certificate from a finished session."""
    if not session.done:
        raise ValueError("isolation not complete; no certificate")
    factors = []
    for i, (f, m) in enumerate(session.factors):
        data = session.factor_data[i]
        roots = [r for r in session.roots if r.factor == i]
        entry = {
            "factor": f.to_json(),
            "multiplicity": m,
            "roots": [r.to_json() for r in roots],
        }
        if data is not None:
            seq = data["sturm"]
            bound = data["bound"]
            entry["sturm"] = [s.to_json() for s in seq]
            entry["bound"] = str(bound)
            entry["variations"] = {
                "at_lower_bound": sign_variations(seq, -bound),
                "at_upper_bound": sign_variations(seq, bound),
            }
        factors.append(entry)
    return {
        "polynomial": session.poly.to_json(),
        "content": str(session.content),
        "factors": factors,
    }


def verify_certificate(cert):
    """Independently verify a certificate.  Returns ``(ok, errors)``."""
    errors = []
    try:
        poly = Poly.from_json(cert["polynomial"])
        content = parse_rational(cert["content"])
        entries = cert["factors"]
    except (KeyError, TypeError, ValueError) as exc:
        return False, ["malformed certificate header: %s" % exc]

    # --- square-free factor relation --------------------------------
    product = Poly([content])
    factors = []
    multiplicities = set()
    for entry in entries:
        try:
            f = Poly.from_json(entry["factor"])
            m = int(entry["multiplicity"])
        except (KeyError, TypeError, ValueError) as exc:
            errors.append("malformed factor entry: %s" % exc)
            continue
        factors.append((f, m, entry))
        if m in multiplicities:
            errors.append("duplicate multiplicity %d in factorization" % m)
        multiplicities.add(m)
        product = product * (f ** m)
    if not product.coeffs == poly.coeffs:
        errors.append("square-free relation content*prod(f_i^i) != polynomial")

    # --- square-freeness, monic, pairwise coprime --------------------
    for f, m, _ in factors:
        if f.degree < 1:
            errors.append("factor %r is constant" % f)
            continue
        if f.lc != 1:
            errors.append("factor %r is not monic" % f)
        if not f.gcd(f.derivative()).is_constant:
            errors.append("factor %r is not square-free" % f)
    for i in range(len(factors)):
        for j in range(i + 1, len(factors)):
            if not factors[i][0].gcd(factors[j][0]).is_constant:
                errors.append("factors %d and %d are not coprime" % (i, j))

    # --- per-factor Sturm chain, variations and root coverage --------
    all_roots = []
    for f, m, entry in factors:
        if f.degree < 1:
            continue
        try:
            seq = [Poly.from_json(s) for s in entry["sturm"]]
            bound = parse_rational(entry["bound"])
            v_lo = int(entry["variations"]["at_lower_bound"])
            v_hi = int(entry["variations"]["at_upper_bound"])
        except (KeyError, TypeError, ValueError) as exc:
            errors.append("malformed sturm/bound data: %s" % exc)
            continue

        # Sturm chain validity: s_0 = f, s_1 = f', s_{k} = -rem(s_{k-2}, s_{k-1})
        if len(seq) < 2 or seq[0] != f or seq[1] != f.derivative():
            errors.append("sturm chain head mismatch for factor %r" % f)
        else:
            for k in range(2, len(seq)):
                if (seq[k - 2] % seq[k - 1]) != -seq[k]:
                    errors.append("sturm remainder %d invalid" % k)
                    break
            else:
                if (seq[-2] % seq[-1]) != Poly():
                    errors.append("sturm chain not properly terminated")
                if not seq[-1].is_constant or seq[-1].is_zero:
                    errors.append("sturm chain does not end in a nonzero constant")

        # bound must be a strict root bound with nonzero endpoints
        if bound < cauchy_bound(f):
            errors.append("bound %s is smaller than the Cauchy bound" % bound)
        if f.evaluate(bound) == 0 or f.evaluate(-bound) == 0:
            errors.append("bound endpoint is a root")

        # recorded variation counts must be exact
        if sign_variations(seq, -bound) != v_lo:
            errors.append("variation count at -B is wrong")
        if sign_variations(seq, bound) != v_hi:
            errors.append("variation count at +B is wrong")

        # roots: each certified, sorted, disjoint, covering all roots
        try:
            roots = [Root.from_json(r) for r in entry["roots"]]
        except (KeyError, TypeError, ValueError) as exc:
            errors.append("malformed root entry: %s" % exc)
            continue
        if len(roots) != v_lo - v_hi:
            errors.append("root count %d does not match variation "
                          "difference %d" % (len(roots), v_lo - v_hi))
        prev = None
        for r in roots:
            if r.multiplicity != m:
                errors.append("root multiplicity mismatch")
            if r.is_point:
                if f.evaluate(r.value) != 0:
                    errors.append("point %s is not a root" % r.value)
                if not (-bound < r.value < bound):
                    errors.append("point root outside the bound")
            else:
                if not (r.lower < r.upper):
                    errors.append("degenerate interval")
                if f.evaluate(r.lower) == 0 or f.evaluate(r.upper) == 0:
                    errors.append("interval endpoint is a root")
                if r.lower < -bound or r.upper > bound:
                    errors.append("interval outside the bound")
                if sign_variations(seq, r.lower) - sign_variations(seq, r.upper) != 1:
                    errors.append("interval (%s, %s) does not contain "
                                  "exactly one root" % (r.lower, r.upper))
            if prev is not None:
                a, b = (prev, r) if prev.sort_key() <= r.sort_key() else (r, prev)
                if prev.sort_key() > r.sort_key():
                    errors.append("roots not sorted")
                if roots_overlap(a, b):
                    errors.append("roots overlap")
            prev = r
        all_roots.extend(roots)

    # --- global disjointness across factors --------------------------
    all_roots.sort(key=lambda r: r.sort_key())
    for i in range(len(all_roots) - 1):
        if roots_overlap(all_roots[i], all_roots[i + 1]):
            errors.append("roots of different factors overlap")
            break

    return (not errors), errors
