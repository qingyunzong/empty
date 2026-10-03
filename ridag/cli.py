"""JSON command-line interface.

Usage:
  python3.11 -m ridag solve  [input.json]   isolate roots, emit claims+cert
  python3.11 -m ridag eval   [input.json]   interval-evaluate an expression
  python3.11 -m ridag verify [cert.json]    independently check a certificate

Input is read from the file argument or stdin; output goes to stdout.
"""

from __future__ import annotations

import json
import sys
from fractions import Fraction

from .dag import DAG
from .evaluator import Evaluator
from .interval import IntervalUnion
from .jsonio import (expr_from_json, interval_from_json, union_to_json,
                     cert_to_json)
from .newton import Isolator
from .cert import verify_certificate


def _read_input(argv):
    if len(argv) > 0 and argv[0] != "-":
        with open(argv[0], "r", encoding="utf-8") as fh:
            return json.load(fh)
    return json.load(sys.stdin)


def cmd_solve(req):
    dag = DAG()
    root = expr_from_json(dag, req["expression"])
    var = req.get("variable", "x")
    dom = req.get("domain", {"lo": "-inf", "lo_open": True,
                             "hi": "inf", "hi_open": True})
    if isinstance(dom, list):
        domain = IntervalUnion([interval_from_json(j) for j in dom])
    else:
        domain = IntervalUnion([interval_from_json(dom)])
    budget = int(req.get("budget", 10000))
    eps = Fraction(req.get("eps", "1/1000000000000000000000000"))
    iso = Isolator(dag, root, var, domain, budget=budget, eps=eps)
    cert = iso.isolate()
    cert_json = cert_to_json(cert)
    ok, errors = verify_certificate(cert_json)
    return {
        "claims": cert_json["claims"],
        "certificate_ok": ok,
        "certificate_errors": errors,
        "certificate": cert_json,
    }


def cmd_eval(req):
    dag = DAG()
    root = expr_from_json(dag, req["expression"])
    ev = Evaluator(dag)
    for name, j in req.get("env", {}).items():
        ev.set(name, IntervalUnion([interval_from_json(j)]))
    r = ev.eval(root)
    return {
        "value": union_to_json(r.value),
        "open_denominators": sorted(r.open_denoms),
    }


def cmd_verify(req):
    ok, errors = verify_certificate(req)
    return {"ok": ok, "errors": errors}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    cmd, rest = argv[0], argv[1:]
    req = _read_input(rest)
    if cmd == "solve":
        out = cmd_solve(req)
    elif cmd == "eval":
        out = cmd_eval(req)
    elif cmd == "verify":
        out = cmd_verify(req)
    else:
        print("unknown command %r" % cmd, file=sys.stderr)
        return 2
    json.dump(out, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
