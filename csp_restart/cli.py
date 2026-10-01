"""Command line interface: python -m csp_restart run ..."""

import argparse
import json
import sys

from .problem import ProblemError, load_problem
from .solver import Solver


def _non_negative_int(text):
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"invalid integer: {text!r}")
    if value < 0:
        raise argparse.ArgumentTypeError(
            f"must be a non-negative integer, got: {text!r}"
        )
    return value


def build_parser():
    parser = argparse.ArgumentParser(
        prog="csp_restart",
        description="CSP solver with conflict-driven restarts (offline, stdlib only).",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="solve a JSON CSP problem")
    run.add_argument("--input", required=True, help="path to the JSON problem file")
    run.add_argument(
        "--restart-threshold",
        required=True,
        type=_non_negative_int,
        help="conflicts since last restart that trigger a restart (non-negative)",
    )
    run.add_argument(
        "--total-budget",
        required=True,
        type=_non_negative_int,
        help="total conflict budget before timeout (non-negative)",
    )
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.command == "run":
        try:
            problem = load_problem(args.input)
        except (OSError, json.JSONDecodeError, ProblemError) as exc:
            print(f"error: invalid problem input: {exc}", file=sys.stderr)
            return 1
        solver = Solver(problem, args.restart_threshold, args.total_budget)
        status = solver.solve()
        output = {
            "status": status,
            "solution": solver.solution,
            "nogoods": [
                {var: nogood[var] for var in sorted(nogood)}
                for nogood in solver.nogoods
            ],
            "restart_count": solver.restart_count,
            "stats": {
                "total_conflicts": solver.total_conflicts,
                "attempts": solver.attempts,
            },
        }
        json.dump(output, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0
    return 2
