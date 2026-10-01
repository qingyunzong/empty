"""CLI: python -m csp_budget propagate --input <file> --budget <non-negative int>"""

from __future__ import annotations

import argparse
import json
import sys

from .solver import CSPError, propagate


def _non_negative_int(text):
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"invalid integer: {text!r}")
    if value < 0:
        raise argparse.ArgumentTypeError("budget must be non-negative")
    return value


def build_parser():
    parser = argparse.ArgumentParser(prog="csp_budget")
    sub = parser.add_subparsers(dest="command", required=True)
    prop = sub.add_parser("propagate", help="run budget-limited AC-3 propagation")
    prop.add_argument("--input", required=True, help="path to the JSON problem file")
    prop.add_argument("--budget", required=True, type=_non_negative_int)
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "propagate":
        try:
            with open(args.input, "r", encoding="utf-8") as fh:
                problem = json.load(fh)
        except OSError as exc:
            print(f"error: cannot read input file: {exc}", file=sys.stderr)
            return 1
        except json.JSONDecodeError as exc:
            print(f"error: invalid JSON input: {exc}", file=sys.stderr)
            return 1

        try:
            result = propagate(problem, args.budget)
        except CSPError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1

        output = {
            "status": result["status"],
            "domains": result["domains"],
            "used_budget": result["used_budget"],
        }
        json.dump(output, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0

    parser.error("unknown command")
    return 2


if __name__ == "__main__":
    sys.exit(main())
