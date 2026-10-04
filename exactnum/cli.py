"""JSON command-line interface for exactnum.

Reads one JSON request from a file (or stdin) and writes one JSON result
to stdout.  Examples::

    {"op": "introot", "n": "1000000", "k": 3}
    {"op": "verify_introot", "evidence": {...}}
    {"op": "floor", "alg": {"poly": ["-2", "0", "1"], "interval": ["1", "2"]}}
    {"op": "round_even", "alg": {...}, "scale": "3/7", "budget": 100}
    {"op": "compare", "a": {...}, "b": {...}}

Use --checkpoint FILE to resume a cached evidence checkpoint and
--save-checkpoint FILE to write one after the request completes.
"""

import argparse
import json
import sys

from .algebraic import (
    AlgebraicNumber,
    EvidenceCache,
    EvidenceError,
    RefinementBudgetExhausted,
    _to_frac,
)
from .introot import (
    IntRootEvidence,
    integer_kth_root,
    verify_introot_evidence,
)


def _parse_alg(spec, cache):
    return AlgebraicNumber(
        spec["poly"], spec["interval"][0], spec["interval"][1], cache=cache
    )


def handle(request, cache):
    if not isinstance(request, dict) or "op" not in request:
        raise ValueError("request must be a JSON object with an 'op' field")
    op = request["op"]

    if op == "introot":
        ev = integer_kth_root(int(request["n"]), int(request["k"]))
        return {"r": str(ev.r), "evidence": ev.to_dict()}

    if op == "verify_introot":
        ev = IntRootEvidence.from_dict(request["evidence"])
        return {"valid": verify_introot_evidence(ev)}

    if op in ("floor", "ceil", "round_even"):
        alg = _parse_alg(request["alg"], cache)
        if "scale" in request:
            alg = alg.scale(_to_frac(request["scale"]))
        budget = request.get("budget")
        fn = {
            "floor": alg.floor,
            "ceil": alg.ceil,
            "round_even": alg.round_half_even,
        }[op]
        try:
            return {"result": str(fn(budget))}
        except RefinementBudgetExhausted:
            return {"error": "budget_exhausted"}

    if op == "compare":
        a = _parse_alg(request["a"], cache)
        b = _parse_alg(request["b"], cache)
        try:
            return {"result": a.compare(b, request.get("budget"))}
        except RefinementBudgetExhausted:
            return {"error": "budget_exhausted"}

    raise ValueError(f"unknown op: {op!r}")


def main(argv=None):
    parser = argparse.ArgumentParser(prog="exactnum")
    parser.add_argument("input", nargs="?",
                        help="JSON request file (default: stdin)")
    parser.add_argument("--checkpoint",
                        help="load a cached evidence checkpoint")
    parser.add_argument("--save-checkpoint",
                        help="write the evidence cache checkpoint after running")
    args = parser.parse_args(argv)

    try:
        if args.input:
            with open(args.input, "r", encoding="utf-8") as fh:
                request = json.load(fh)
        else:
            request = json.load(sys.stdin)
    except (OSError, json.JSONDecodeError) as exc:
        json.dump({"error": f"bad request: {exc}"}, sys.stdout)
        print()
        return 2

    try:
        cache = EvidenceCache.load(args.checkpoint) if args.checkpoint \
            else EvidenceCache()
    except (OSError, json.JSONDecodeError, EvidenceError) as exc:
        json.dump({"error": f"invalid evidence: {exc}"}, sys.stdout)
        print()
        return 1

    try:
        result = handle(request, cache)
    except (ValueError, TypeError, KeyError, EvidenceError) as exc:
        result = {"error": str(exc)}

    if args.save_checkpoint:
        cache.save(args.save_checkpoint)

    json.dump(result, sys.stdout, indent=2)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
