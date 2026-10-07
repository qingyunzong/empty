"""Isolation certificates: squarefree factorization, Sturm data, coverage."""

from . import poly as P
from .isolate import isolate
from .jsonutil import enc_frac, enc_poly, enc_root
from .sturm import sign_variations_at, sturm_sequence, total_real_roots


def make_certificate(coeffs, roots, eps=None):
    """Build a certificate from a polynomial and its finalized root list."""
    coeffs = P.normalize(coeffs)
    leading, facs = P.squarefree_factors(coeffs)
    facs = [(f, m) for f, m in facs if P.degree(f) >= 1]
    sturms = [sturm_sequence(f) for f, _ in facs]
    cert = {
        "polynomial": enc_poly(coeffs),
        "leading_coefficient": enc_frac(leading),
        "squarefree_factors": [
            {
                "factor": enc_poly(f),
                "multiplicity": m,
                "sturm": [enc_poly(s) for s in st],
                "total_real_roots": total_real_roots(st),
            }
            for (f, m), st in zip(facs, sturms)
        ],
        "roots": [],
        "eps": enc_frac(eps) if eps is not None else None,
    }
    for r in roots:
        entry = enc_root(r)
        if r["kind"] == "interval":
            st = sturms[r["factor"]]
            entry["sign_variations_lo"] = sign_variations_at(st, r["lo"])
            entry["sign_variations_hi"] = sign_variations_at(st, r["hi"])
        cert["roots"].append(entry)
    return cert


def build_certificate(coeffs, eps=None):
    """Fully isolate the polynomial and return (certificate, roots)."""
    status, roots, _ = isolate(P.normalize(coeffs), eps)
    if status != "ok":
        raise RuntimeError("isolation did not finish")
    return make_certificate(coeffs, roots, eps), roots
