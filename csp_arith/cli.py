"""Command line interface: python -m csp_arith explain --input <file>."""

import argparse
import json
import sys

from .model import ProblemError, load_problem
from .solver import Propagator

EXIT_OK = 0
EXIT_INPUT_ERROR = 2


def _cmd_explain(input_path):
    try:
        with open(input_path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except OSError as exc:
        print(json.dumps({"error": f"cannot read input file: {exc}"}), file=sys.stderr)
        return EXIT_INPUT_ERROR
    except json.JSONDecodeError as exc:
        print(json.dumps({"error": f"invalid JSON: {exc}"}), file=sys.stderr)
        return EXIT_INPUT_ERROR

    try:
        problem = load_problem(data)
    except ProblemError as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return EXIT_INPUT_ERROR

    propagator = Propagator(problem.variables, problem.constraints)
    consistent = propagator.propagate()
    result = {
        "status": "sat" if consistent else "unsat",
        "domains": propagator.sorted_domains(),
        "explanations": propagator.explanation_report(),
        "conflict": propagator.conflict_report(),
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    return EXIT_OK


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="csp_arith",
        description="Integer binary arithmetic CSP solver with lazy explanations",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    explain = subparsers.add_parser(
        "explain", help="propagate and report domains plus removal explanations"
    )
    explain.add_argument("--input", required=True, help="path to the problem JSON file")
    args = parser.parse_args(argv)

    if args.command == "explain":
        return _cmd_explain(args.input)
    parser.error(f"unknown command {args.command!r}")
    return EXIT_INPUT_ERROR
