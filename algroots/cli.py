"""JSON command-line interface.

Usage (JSON via --input string or stdin):

    python3.11 -m algroots isolate --input '{"poly": ["-2","0","1"]}'
    python3.11 -m algroots isolate --input '{"state": <state>, "budget": 10}'
    python3.11 -m algroots refine  --input '{"poly": [...], "index": 1,
                                             "epsilon": "1/1000"}'
    python3.11 -m algroots compare --input '{"poly1": [...], "index1": 1,
                                             "poly2": [...], "index2": 0}'
    python3.11 -m algroots verify  --input '{"certificate": {...}}'

Polynomials are JSON arrays of rational coefficients in ascending degree
order; rationals are integers or "p/q" strings.
"""
from __future__ import annotations

import argparse
import json
import sys

from .budget import Budget
from .certificate import build_certificate, verify_certificate
from .compare import compare_roots
from .isolate import IsolationSession, refine_to
from .poly import Poly


def _read_params(args):
    if args.input is not None:
        return json.loads(args.input)
    return json.load(sys.stdin)


def _session_output(session):
    out = {
        "status": session.status,
        "roots": [r.to_json() for r in session.roots],
        "stats": session.stats,
        "state": session.to_state(),
    }
    if session.done:
        out["certificate"] = build_certificate(session)
    return out


def cmd_isolate(params):
    budget = params.get("budget")
    if "state" in params:
        session = IsolationSession.from_state(params["state"])
    else:
        session = IsolationSession(Poly.from_json(params["poly"]))
    session.run(budget=budget)
    return _session_output(session)


def cmd_refine(params):
    session = IsolationSession(Poly.from_json(params["poly"]))
    session.run(budget=params.get("budget"))
    if not session.done:
        return _session_output(session)
    index = int(params["index"])
    root = session.roots[index]
    f = session.factors[root.factor][0]
    budget = Budget(params.get("refine_budget"), session.stats)
    root, ok = refine_to(f, root, params["epsilon"], budget)
    session.roots[index] = root
    out = _session_output(session)
    out["root"] = root.to_json()
    out["refined"] = ok
    if not ok:
        out["status"] = "pending"
    return out


def cmd_compare(params):
    s1 = IsolationSession(Poly.from_json(params["poly1"])).run(
        params.get("budget"))
    s2 = IsolationSession(Poly.from_json(params["poly2"])).run(
        params.get("budget"))
    if not (s1.done and s2.done):
        return {"status": "pending",
                "state1": s1.to_state(), "state2": s2.to_state()}
    r1 = s1.roots[int(params["index1"])]
    r2 = s2.roots[int(params["index2"])]
    f1 = s1.factors[r1.factor][0]
    f2 = s2.factors[r2.factor][0]
    rel = compare_roots(f1, r1, f2, r2)
    return {
        "status": "done",
        "relation": {-1: "lt", 0: "eq", 1: "gt"}[rel],
        "root1": r1.to_json(),
        "root2": r2.to_json(),
    }


def cmd_verify(params):
    ok, errors = verify_certificate(params["certificate"])
    return {"valid": ok, "errors": errors}


COMMANDS = {
    "isolate": cmd_isolate,
    "refine": cmd_refine,
    "compare": cmd_compare,
    "verify": cmd_verify,
}


def main(argv=None):
    parser = argparse.ArgumentParser(prog="algroots", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in COMMANDS:
        p = sub.add_parser(name)
        p.add_argument("--input", help="JSON input string (default: stdin)")
    args = parser.parse_args(argv)
    try:
        params = _read_params(args)
        result = COMMANDS[args.command](params)
    except Exception as exc:  # noqa: BLE001 - CLI must report, not crash
        json.dump({"error": "%s: %s" % (type(exc).__name__, exc)},
                  sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 1
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
