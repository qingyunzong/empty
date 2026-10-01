"""JSON CLI: reads one JSON request from stdin, writes one JSON response.

Request fields:
  op        parse | match | equivalent | included | shortest_difference
            | minimize | verify_proof
  alphabet  "abc" | [["a","z"],...] | [[97,122],...]   (required except
            for plain "parse" without '.' / negated classes)
  pattern   regex string (for parse/match/minimize)
  r1, r2    regex strings or structured expressions (for binary ops)
  string    input string (for match)
  budget    optional max number of product states to explore
  frontier  frontier object from a previous "unknown" result (resume)
  proof     proof object (for verify_proof)

Responses carry a "status" field; see regex_deriv.algebra for details.
"""
from __future__ import annotations

import json
import sys

from . import algebra
from .alphabet import parse_alphabet
from .automaton import BudgetExceeded, build_dfa, minimize
from .parser import parse
from .syntax import from_json, from_raw, to_json


def _expr(req, key, alphabet):
    v = req[key]
    if isinstance(v, str):
        return from_raw(parse(v, alphabet))
    return from_json(v)


def handle(req):
    op = req["op"]
    alphabet = parse_alphabet(req["alphabet"]) if "alphabet" in req else None

    if op == "parse":
        return {"status": "ok",
                "expr": to_json(from_raw(parse(req["pattern"], alphabet)))}

    if op == "match":
        node = _expr(req, "pattern", alphabet)
        return {"status": "ok",
                "match": algebra.match(node, req["string"], alphabet)}

    if op in ("equivalent", "included", "shortest_difference"):
        a = _expr(req, "r1", alphabet)
        b = _expr(req, "r2", alphabet)
        fn = {"equivalent": algebra.equivalent,
              "included": algebra.included,
              "shortest_difference": algebra.shortest_difference}[op]
        kw = {}
        if "budget" in req:
            kw["max_states"] = req["budget"]
        if "frontier" in req:
            kw["frontier"] = req["frontier"]
        return fn(a, b, alphabet, **kw)

    if op == "minimize":
        node = _expr(req, "pattern", alphabet)
        try:
            dfa = minimize(
                build_dfa(node, alphabet, req.get("budget")), alphabet)
        except BudgetExceeded as exc:
            return {"status": "unknown", "reason": str(exc)}
        return {"status": "ok", "dfa": dfa.to_json()}

    if op == "verify_proof":
        a = _expr(req, "r1", alphabet)
        b = _expr(req, "r2", alphabet)
        return {"status": "ok",
                "valid": algebra.verify_proof(a, b, alphabet, req["proof"])}

    raise ValueError(f"unknown op: {op!r}")


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv:
        with open(argv[0], "r", encoding="utf-8") as fh:
            req = json.load(fh)
    else:
        req = json.load(sys.stdin)
    try:
        out = handle(req)
    except (ValueError, SyntaxError, KeyError) as exc:
        out = {"status": "error", "error": str(exc)}
    json.dump(out, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
