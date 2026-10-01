"""Command line interface: python -m csp_budget propagate --input F --budget N"""

import argparse
import json
import sys

from .solver import InputError, propagate, validate_problem


def _build_parser():
    parser = argparse.ArgumentParser(
        prog="csp_budget",
        description="Budget-limited AC-3 constraint propagation.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    propagate_parser = subparsers.add_parser(
        "propagate", help="run budget-limited AC-3 propagation"
    )
    propagate_parser.add_argument(
        "--input", required=True, help="path to the JSON CSP problem file"
    )
    propagate_parser.add_argument(
        "--budget",
        required=True,
        type=int,
        help="non-negative propagation budget (one unit per value-match check)",
    )
    return parser


def _fail(message):
    print("error: %s" % message, file=sys.stderr)
    return 1


def main(argv=None):
    args = _build_parser().parse_args(argv)
    if args.command == "propagate":
        if args.budget < 0:
            return _fail("budget must be a non-negative integer")
        try:
            with open(args.input, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except OSError as exc:
            return _fail("cannot read input file: %s" % exc)
        except json.JSONDecodeError as exc:
            return _fail("invalid JSON input: %s" % exc)
        try:
            variables, constraints = validate_problem(data)
            result = propagate(variables, constraints, args.budget)
        except InputError as exc:
            return _fail(str(exc))
        json.dump(result, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
