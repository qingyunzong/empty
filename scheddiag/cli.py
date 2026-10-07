"""JSON command-line interface.

Usage: python3.11 -m scheddiag [request.json]   (stdin if no file given)

Solve request::
    {"command": "solve",
     "instance": {"num_tasks": 2, "durations": [3, 3],
                  "constraints": [{"u": 0, "v": "zero", "w": 1}],
                  "disjuncts": [[0, 1]]},
     "budget": {"slack": 1000, "branches": 100},
     "frontier": <optional token from a previous unknown result>}

Check request::
    {"command": "check", "instance": {...}, "evidence": {...}}
"""

from __future__ import annotations

import argparse
import json
import sys

from .checker import check_evidence, parse_instance
from .solver import InputError, Solver


def build_solver(inst):
    solver = Solver(inst.num_tasks, inst.durations)
    for (a, b) in inst.disjuncts:
        solver.add_disjunct(a, b)
    for (u, v, w) in inst.constraints:
        solver.add_constraint(u, v, w)
    return solver


def cmd_solve(request):
    inst = parse_instance(request.get("instance"))
    solver = build_solver(inst)
    budget = request.get("budget") or {}
    if not isinstance(budget, dict):
        raise InputError("budget must be an object")
    return solver.solve(
        slack_budget=budget.get("slack"),
        branch_budget=budget.get("branches"),
        frontier=request.get("frontier"),
    )


def cmd_check(request):
    inst = parse_instance(request.get("instance"))
    ok, reason = check_evidence(inst, request.get("evidence"))
    return {"valid": ok, "reason": reason}


def handle(request):
    if not isinstance(request, dict):
        raise InputError("request must be a JSON object")
    command = request.get("command", "solve")
    if command == "solve":
        return cmd_solve(request)
    if command == "check":
        return cmd_check(request)
    raise InputError(f"unknown command {command!r}")


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="scheddiag",
        description="Integer difference + disjunctive interval scheduler")
    parser.add_argument("input", nargs="?",
                        help="JSON request file (default: read from stdin)")
    args = parser.parse_args(argv)
    try:
        raw = sys.stdin.read() if args.input is None else open(args.input).read()
        request = json.loads(raw)
    except OSError as exc:
        print(json.dumps({"status": "error", "error": f"cannot read input: {exc}"}))
        return 2
    except json.JSONDecodeError as exc:
        print(json.dumps({"status": "error", "error": f"invalid JSON: {exc}"}))
        return 2
    try:
        result = handle(request)
    except InputError as exc:
        print(json.dumps({"status": "error", "error": str(exc)}))
        return 2
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
