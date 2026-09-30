"""JSON command-line interface.

    python3.11 -m schedsolve solve  INSTANCE [--relax-budget N]
                                            [--branch-budget N]
                                            [--frontier FRONTIER.json]
    python3.11 -m schedsolve check  INSTANCE RESULT.json
    python3.11 -m schedsolve brute  INSTANCE [--horizon H]

All input/output is JSON on stdout; diagnostics go to stderr.
Exit codes: 0 success / evidence valid, 1 evidence invalid, 2 usage or
input error.
"""

from __future__ import annotations

import argparse
import json
import sys

from .brute import brute_force, safe_horizon
from .checker import CheckFailure, check as check_evidence
from .errors import SchedSolveError
from .solver import Solver


def _load_json(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except OSError as exc:
        raise SchedSolveError(f"cannot read {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise SchedSolveError(f"invalid JSON in {path}: {exc}") from exc


def build_solver(inst):
    """Construct a Solver from a validated instance dict."""
    from .checker import validate_instance  # validation only, no search logic

    n, durations, base_edges, disjuncts = validate_instance(inst)
    solver = Solver(n, durations)
    for uid, (u, v, c) in base_edges.items():
        solver.add_constraint(u, v, c, uid=uid)
    for i, j in disjuncts:
        solver.add_disjunct(i, j)
    return solver


def _cmd_solve(args):
    inst = _load_json(args.instance)
    solver = build_solver(inst)
    frontier = _load_json(args.frontier) if args.frontier else None
    result = solver.solve(relax_budget=args.relax_budget,
                          branch_budget=args.branch_budget,
                          frontier=frontier)
    json.dump(result.to_json(), sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


def _cmd_check(args):
    inst = _load_json(args.instance)
    result = _load_json(args.result)
    ok, reason = check_evidence(inst, result)
    json.dump({"valid": ok, "reason": reason}, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0 if ok else 1


def _cmd_brute(args):
    inst = _load_json(args.instance)
    from .checker import validate_instance

    n, durations, base_edges, disjuncts = validate_instance(inst)
    horizon = args.horizon
    if horizon is None:
        horizon = safe_horizon(durations, list(base_edges.values()))
    status, schedule = brute_force(
        n, durations, list(base_edges.values()), disjuncts, horizon)
    out = {"status": status, "horizon": horizon}
    if schedule is not None:
        out["schedule"] = schedule
    json.dump(out, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="schedsolve",
        description="Integer difference constraints + disjunctive interval "
                    "scheduling with budgets and replayable evidence.")
    sub = parser.add_subparsers(dest="command", required=True)

    p_solve = sub.add_parser("solve", help="solve an instance (JSON in/out)")
    p_solve.add_argument("instance")
    p_solve.add_argument("--relax-budget", type=int, default=None,
                         help="max potential-relaxation steps")
    p_solve.add_argument("--branch-budget", type=int, default=None,
                         help="max branch nodes")
    p_solve.add_argument("--frontier", default=None,
                         help="JSON frontier from a previous 'unknown' run")
    p_solve.set_defaults(func=_cmd_solve)

    p_check = sub.add_parser("check", help="independently verify a result")
    p_check.add_argument("instance")
    p_check.add_argument("result")
    p_check.set_defaults(func=_cmd_check)

    p_brute = sub.add_parser("brute", help="bounded enumeration oracle")
    p_brute.add_argument("instance")
    p_brute.add_argument("--horizon", type=int, default=None)
    p_brute.set_defaults(func=_cmd_brute)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (SchedSolveError, CheckFailure) as exc:
        json.dump({"error": str(exc)}, sys.stderr)
        sys.stderr.write("\n")
        return 2


if __name__ == "__main__":
    sys.exit(main())
