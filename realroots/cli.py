"""JSON command-line interface.

Reads one JSON request from a file (argv[1]) or stdin, writes one JSON
response to stdout.  Commands:

  isolate   {"cmd":"isolate","polynomial":[...],"eps":"1/1000"?,
             "budget":N?,"certificate":true?}
  resume    {"cmd":"resume","state":{...},"budget":N?,"eps":"1/10^6"?}
  compare   {"cmd":"compare","a":{"polynomial":[...],"root":{...}},
             "b":{...}}
  refine    {"cmd":"refine","polynomial":[...],"root":{...},"eps":"1/1024"}
  verify    {"cmd":"verify","certificate":{...}}

A root is {"kind":"point","value":"r"} or {"kind":"interval","lo","hi"}.
"""

import json
import sys

from . import poly as P
from .algebraic import AlgebraicNumber, compare
from .certificate import make_certificate
from .isolate import Engine, finalize, refine_root, run
from .jsonutil import (dec_frac, dec_poly, dec_state, enc_root, enc_state)
from .verify import verify_certificate


def _isolate_response(coeffs, eng, status, with_certificate, eps):
    resp = {
        "status": "ok" if status == "done" else "budget_exhausted",
        "ops": eng.ops,
        "pending": eng.pending(),
        "state": enc_state(eng),
    }
    if status == "done":
        roots = finalize(eng.done, eng.factors)
        resp["roots"] = [enc_root(r) for r in roots]
        if with_certificate:
            resp["certificate"] = make_certificate(coeffs, roots, eps)
    else:
        # Frontier saved in "state"; these are the roots finished so far.
        resp["roots_so_far"] = [enc_root(r) for r in eng.done]
    return resp


def _cmd_isolate(req):
    coeffs = dec_poly(req["polynomial"])
    if P.is_zero(coeffs):
        return {"status": "error",
                "error": "zero polynomial: every real number is a root"}
    eps = dec_frac(req["eps"]) if req.get("eps") is not None else None
    if eps is not None and eps <= 0:
        return {"status": "error", "error": "eps must be positive"}
    _, facs = P.squarefree_factors(coeffs)
    facs = [(f, m) for f, m in facs if P.degree(f) >= 1]
    eng = Engine(facs, eps)
    status = run(eng, req.get("budget"))
    return _isolate_response(coeffs, eng, status,
                             bool(req.get("certificate")), eps)


def _cmd_resume(req):
    eng = dec_state(req["state"])
    if req.get("eps") is not None:
        eps = dec_frac(req["eps"])
        if eps <= 0:
            return {"status": "error", "error": "eps must be positive"}
        eng.eps = eps
    status = run(eng, req.get("budget"))
    resp = {
        "status": "ok" if status == "done" else "budget_exhausted",
        "ops": eng.ops,
        "pending": eng.pending(),
        "state": enc_state(eng),
    }
    if status == "done":
        roots = finalize(eng.done, eng.factors)
        resp["roots"] = [enc_root(r) for r in roots]
    else:
        resp["roots_so_far"] = [enc_root(r) for r in eng.done]
    return resp


def _algebraic_from_spec(spec):
    coeffs = dec_poly(spec["polynomial"])
    if P.is_zero(coeffs):
        raise ValueError("zero polynomial: every real number is a root")
    root = spec["root"]
    if root["kind"] == "point":
        return AlgebraicNumber.from_polynomial(coeffs, "point",
                                               dec_frac(root["value"]))
    return AlgebraicNumber.from_polynomial(coeffs, "interval",
                                           dec_frac(root["lo"]),
                                           dec_frac(root["hi"]))


def _cmd_compare(req):
    a = _algebraic_from_spec(req["a"])
    b = _algebraic_from_spec(req["b"])
    outcome = compare(a, b)
    return {
        "status": "ok",
        "relation": {-1: "less", 0: "equal", 1: "greater"}[outcome],
        "a_multiplicity": a.multiplicity,
        "b_multiplicity": b.multiplicity,
        "a": a.to_dict(),
        "b": b.to_dict(),
    }


def _cmd_refine(req):
    an = _algebraic_from_spec(req)
    eps = dec_frac(req["eps"])
    if eps <= 0:
        return {"status": "error", "error": "eps must be positive"}
    root = {"kind": an.kind, "lo": an.lo, "hi": an.hi,
            "factor": 0, "multiplicity": an.multiplicity}
    out = refine_root(an.factor, root, eps)
    return {"status": "ok", "root": enc_root(out),
            "multiplicity": an.multiplicity}


def _cmd_verify(req):
    ok, checks = verify_certificate(req["certificate"])
    return {"status": "ok", "valid": ok, "checks": checks}


_COMMANDS = {
    "isolate": _cmd_isolate,
    "resume": _cmd_resume,
    "compare": _cmd_compare,
    "refine": _cmd_refine,
    "verify": _cmd_verify,
}


def handle(req):
    try:
        handler = _COMMANDS[req["cmd"]]
    except KeyError:
        return {"status": "error", "error": f"unknown command {req.get('cmd')!r}"}
    try:
        return handler(req)
    except (ValueError, KeyError, TypeError, ZeroDivisionError) as exc:
        return {"status": "error", "error": str(exc)}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv:
        with open(argv[0], "r", encoding="utf-8") as fh:
            req = json.load(fh)
    else:
        req = json.load(sys.stdin)
    json.dump(handle(req), sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
