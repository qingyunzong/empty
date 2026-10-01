"""Command line interface: python -m csp_trail run --input P --assign JSON [--backtrack N]."""

from __future__ import annotations

import argparse
import json
import sys

from .core import CspError, Problem, Solver


def build_parser():
    parser = argparse.ArgumentParser(prog="csp_trail")
    subparsers = parser.add_subparsers(dest="command", required=True)
    run = subparsers.add_parser("run", help="load a problem, assign, optionally backtrack")
    run.add_argument("--input", required=True, help="path to the problem JSON file")
    run.add_argument(
        "--assign",
        default=None,
        help='JSON object mapping variables to values, e.g. \'{"x": 1}\'',
    )
    run.add_argument(
        "--backtrack",
        type=int,
        default=None,
        help="decision level to backtrack to after assignments",
    )
    return parser


def _run(args):
    problem = Problem.from_json_file(args.input)
    solver = Solver(problem)
    if solver.status != "unsat":
        if args.assign is not None:
            try:
                mapping = json.loads(args.assign)
            except json.JSONDecodeError as exc:
                raise CspError(f"invalid --assign JSON: {exc}") from exc
            if not isinstance(mapping, dict):
                raise CspError("--assign must be a JSON object of variable=value")
            for var, value in mapping.items():
                if not isinstance(value, int) or isinstance(value, bool):
                    raise CspError(f"value for '{var}' must be an integer")
                if not solver.assign(var, value):
                    break  # conflict: stop applying further assignments
        if args.backtrack is not None:
            solver.backtrack(args.backtrack)
    json.dump(solver.snapshot(), sys.stdout)
    sys.stdout.write("\n")
    return 0


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        if args.command == "run":
            return _run(args)
    except CspError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0
