"""JSON command-line interface.

Reads one JSON object from stdin (or the file named by argv[1]) and
writes one JSON object to stdout.  Coefficients are decimal strings or
ints, constant term first; rationals are "num/den" strings.

Operations:
  {"op": "gcd", "f": [...], "g": [...], "budget": N, "primes": [...],
   "state": {...}, "include_bezout": true}
  {"op": "verify_bezout", "f": [...], "g": [...], "certificate": {...}}
  {"op": "content_pp", "f": [...]}
  {"op": "euclid_gcd", "f": [...], "g": [...]}   (independent checker)
"""

import json
import sys

from . import poly
from .bezout import (
    bezout_certificate,
    cert_from_json,
    cert_to_json,
    verify_bezout,
)
from .euclid import euclid_gcd_qq
from .modular_gcd import gcd_modular


def _result_to_json(result):
    out = {
        "status": result.status,
        "content_gcd": str(result.content_gcd),
        "primes_used": [str(p) for p in result.primes_used],
        "bad_primes": {
            k: [str(p) for p in v] for k, v in result.bad_primes.items()
        },
        "modulus": str(result.modulus),
        "best_degree": result.best_degree,
    }
    if result.status == "ok":
        out["gcd"] = poly.render(result.gcd)
        out["checks"] = result.checks
    else:
        out["state"] = result.state
        out["pending"] = result.pending
    return out


def handle(request):
    op = request.get("op")
    if op == "gcd":
        f = poly.parse(request["f"])
        g = poly.parse(request["g"])
        result = gcd_modular(
            f,
            g,
            budget=request.get("budget"),
            state=request.get("state"),
            primes=[int(p) for p in request["primes"]] if request.get("primes") else None,
        )
        out = _result_to_json(result)
        if request.get("include_bezout") and result.status == "ok":
            cert = bezout_certificate(f, g, result.gcd)
            out["bezout"] = cert_to_json(cert)
            out["bezout_selfcheck"] = verify_bezout(f, g, cert)
        return out
    if op == "verify_bezout":
        f = poly.parse(request["f"])
        g = poly.parse(request["g"])
        cert = cert_from_json(request["certificate"])
        return {"valid": verify_bezout(f, g, cert)}
    if op == "content_pp":
        f = poly.parse(request["f"])
        return {
            "content": str(poly.content(f)),
            "primitive_part": poly.render(poly.primitive_part(f)),
        }
    if op == "euclid_gcd":
        f = poly.parse(request["f"])
        g = poly.parse(request["g"])
        return {"gcd": poly.render(euclid_gcd_qq(f, g))}
    return {"error": f"unknown op: {op!r}"}


def main(argv=None):
    argv = sys.argv if argv is None else argv
    try:
        if len(argv) > 1:
            with open(argv[1], "r", encoding="utf-8") as fh:
                request = json.load(fh)
        else:
            request = json.load(sys.stdin)
        response = handle(request)
        code = 0 if "error" not in response else 2
    except (ValueError, KeyError, ZeroDivisionError) as exc:
        response = {"error": f"{type(exc).__name__}: {exc}"}
        code = 2
    json.dump(response, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
