"""JSON (de)serialization of exact rationals, polynomials and engine state.

Rationals are encoded as integers (``3``) or strings (``"2/3"``); floats
are rejected on decoding to guarantee exactness.
"""

from collections import deque
from fractions import Fraction

from . import poly as P
from .isolate import Engine


def enc_frac(x):
    x = Fraction(x)
    if x.denominator == 1:
        return x.numerator
    return f"{x.numerator}/{x.denominator}"


def dec_frac(v):
    if isinstance(v, bool):
        raise ValueError(f"not an exact rational: {v!r}")
    if isinstance(v, int):
        return Fraction(v)
    if isinstance(v, str):
        return Fraction(v)
    raise ValueError(f"not an exact rational (floats are not allowed): {v!r}")


def enc_poly(p):
    return [enc_frac(c) for c in p]


def dec_poly(coeffs):
    return P.normalize(dec_frac(c) for c in coeffs)


def enc_root(root):
    out = {"kind": root["kind"], "multiplicity": root["multiplicity"],
           "factor": root["factor"]}
    if root["kind"] == "point":
        out["value"] = enc_frac(root["lo"])
    else:
        out["lo"] = enc_frac(root["lo"])
        out["hi"] = enc_frac(root["hi"])
    return out


def dec_root(d):
    if d["kind"] == "point":
        lo = hi = dec_frac(d["value"])
    else:
        lo, hi = dec_frac(d["lo"]), dec_frac(d["hi"])
    return {"kind": d["kind"], "lo": lo, "hi": hi,
            "multiplicity": d.get("multiplicity"), "factor": d.get("factor")}


def enc_item(item):
    out = {"type": item["type"], "factor": item["factor"],
           "lo": enc_frac(item["lo"]), "hi": enc_frac(item["hi"])}
    if item["type"] == "split":
        out["n"] = item["n"]
    return out


def dec_item(d):
    item = {"type": d["type"], "factor": d["factor"],
            "lo": dec_frac(d["lo"]), "hi": dec_frac(d["hi"])}
    if d["type"] == "split":
        item["n"] = d["n"]
    return item


def enc_state(eng):
    """Serialize the full engine frontier so a budget-limited run can resume."""
    return {
        "factors": [{"poly": enc_poly(f), "multiplicity": m}
                    for f, m in eng.factors],
        "eps": enc_frac(eng.eps) if eng.eps is not None else None,
        "done": [enc_root(r) for r in eng.done],
        "queue": [enc_item(i) for i in eng.queue],
        "init_upto": eng.init_upto,
        "ops": eng.ops,
        "finished": eng.finished,
    }


def dec_state(s):
    eng = Engine(
        [(dec_poly(f["poly"]), f["multiplicity"]) for f in s["factors"]],
        dec_frac(s["eps"]) if s["eps"] is not None else None,
    )
    eng.done = [dec_root(r) for r in s["done"]]
    eng.queue = deque(dec_item(i) for i in s["queue"])
    eng.init_upto = s["init_upto"]
    eng.ops = s["ops"]
    eng.finished = s["finished"]
    return eng
