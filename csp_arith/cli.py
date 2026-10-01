"""Command line interface: ``python -m csp_arith explain --input <file>``."""

import argparse
import json
import sys

from .core import ProblemError, propagate
from .model import load_problem

EXIT_OK = 0
EXIT_ERROR = 2


def _build_parser():
    parser = argparse.ArgumentParser(
        prog="csp_arith",
        description="Integer binary arithmetic constraint propagation "
        "with lazy explanation generation (offline).",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    explain = subparsers.add_parser(
        "explain",
        help="propagate constraints and explain every pruned value",
    )
    explain.add_argument(
        "--input",
        required=True,
        help="path to the JSON problem file",
    )
    return parser


def main(argv=None):
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.command == "explain":
        try:
            domains, constraints = load_problem(args.input)
        except ProblemError as exc:
            json.dump({"error": str(exc)}, sys.stderr, ensure_ascii=False)
            sys.stderr.write("\n")
            return EXIT_ERROR
        result = propagate(domains, constraints)
        json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        return EXIT_OK
    parser.error("unknown command: %s" % args.command)
    return EXIT_ERROR
