"""JSON command-line interface.

Reads one JSON request from a file argument or stdin, writes one JSON
response to stdout.  Commands:

  analyze : {"command": "analyze", "matrix": [[...]], "rhs": [[...], ...],
             "checkpoint_out": "path.json"}
  update  : {"command": "update", "checkpoint_in": "path.json",
             "replace_rows": {"0": [...]}, "add_rows": [[...]],
             "rhs": [[...], ...], "checkpoint_out": "path2.json"}
"""
from __future__ import annotations

import json
import sys
from fractions import Fraction

from .core import LinearSystem
from .verify import verify_solutions


def _json_value(value):
    if isinstance(value, Fraction):
        if value.denominator == 1:
            return value.numerator
        return f"{value.numerator}/{value.denominator}"
    if isinstance(value, list):
        return [_json_value(v) for v in value]
    return value


def _encode_solution(sol):
    return {"status": sol["status"],
            "particular": _json_value(sol["particular"])
            if sol["particular"] is not None else None,
            "null_basis": _json_value(sol["null_basis"]),
            "certificate": sol["certificate"]}


def handle(request):
    command = request.get("command", "analyze")
    if command == "analyze":
        system = LinearSystem(request["matrix"])
    elif command == "update":
        system = LinearSystem.load_checkpoint(request["checkpoint_in"])
        replace = {int(k): v for k, v in
                   (request.get("replace_rows") or {}).items()}
        system = system.updated(replace_rows=replace,
                                add_rows=request.get("add_rows"))
    else:
        raise ValueError(f"unknown command: {command!r}")

    fact = system.factorization
    out = {
        "command": command,
        "rows": fact.rows,
        "cols": fact.cols,
        "rank": fact.rank,
        "row_perm": fact.row_perm,
        "col_perm": fact.col_perm,
        "row_swaps": fact.row_swaps,
        "col_swaps": fact.col_swaps,
        "notes": fact.notes,
        "elimination_log": fact.steps,
        "reused_steps": sum(1 for s in fact.steps if s.get("reused")),
    }
    if fact.rows == fact.cols:
        out["determinant"] = fact.determinant()

    rhs = request.get("rhs")
    if rhs:
        solutions = system.solve(rhs)
        out["solutions"] = [_encode_solution(s) for s in solutions]
        if request.get("verify", True):
            out["verification"] = verify_solutions(
                fact.matrix, rhs, solutions, fact.rank)

    if "checkpoint_out" in request:
        system.save_checkpoint(request["checkpoint_out"])
        out["checkpoint_out"] = request["checkpoint_out"]
    return out


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv:
        with open(argv[0], "r", encoding="utf-8") as fh:
            request = json.load(fh)
    else:
        request = json.load(sys.stdin)
    try:
        response = handle(request)
    except Exception as exc:  # report as JSON, nonzero exit
        json.dump({"error": f"{type(exc).__name__}: {exc}"}, sys.stdout,
                  indent=2)
        sys.stdout.write("\n")
        return 1
    json.dump(response, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
