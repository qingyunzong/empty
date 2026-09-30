"""Command line interface: python -m csp_restart run ..."""

import argparse
import json
import sys

from .model import ProblemError, load_problem
from .solver import Solver


def build_parser():
    parser = argparse.ArgumentParser(
        prog="csp_restart",
        description="CSP solver with conflict-triggered restarts (offline).",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    run = subparsers.add_parser("run", help="solve a JSON CSP problem")
    run.add_argument("--input", required=True, help="path to the JSON problem file")
    run.add_argument(
        "--restart-threshold",
        type=int,
        required=True,
        help="conflicts since last restart that trigger a restart (non-negative)",
    )
    run.add_argument(
        "--total-budget",
        type=int,
        required=True,
        help="total conflict budget before the search is aborted (non-negative)",
    )
    return parser


def cmd_run(args, parser):
    if args.restart_threshold < 0:
        parser.error("--restart-threshold must be a non-negative integer")
    if args.total_budget < 0:
        parser.error("--total-budget must be a non-negative integer")
    try:
        with open(args.input, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except OSError as exc:
        print(f"error: cannot read input file: {exc}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as exc:
        print(f"error: invalid JSON in input file: {exc}", file=sys.stderr)
        return 1
    try:
        problem = load_problem(data)
    except ProblemError as exc:
        print(f"error: invalid problem: {exc}", file=sys.stderr)
        return 1
    solver = Solver(problem, args.restart_threshold, args.total_budget)
    result = solver.solve()
    print(json.dumps(result.to_dict(), indent=2, ensure_ascii=False))
    return 0


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "run":
        return cmd_run(args, parser)
    parser.error(f"unknown command: {args.command!r}")
    return 2
