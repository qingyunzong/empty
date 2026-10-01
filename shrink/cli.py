"""Command line interface: python -m shrink minimize case.json --budget N [--out out.json]"""

import argparse
import json
import sys

from .case import validate_case
from .errors import CaseError
from .minimize import minimize_case


def _build_parser():
    parser = argparse.ArgumentParser(
        prog="shrink",
        description="Minimize a failing op sequence while preserving the failure.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    minimize = subparsers.add_parser(
        "minimize", help="minimize a case file under a check budget"
    )
    minimize.add_argument("case", help="path to the case JSON file")
    minimize.add_argument(
        "--budget",
        type=int,
        default=200,
        help="maximum number of predicate checks (default: 200)",
    )
    minimize.add_argument(
        "--out",
        help="write the result JSON to this file (default: stdout)",
    )
    return parser


def _cmd_minimize(args):
    try:
        with open(args.case, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except OSError as exc:
        print(f"error: cannot read case file: {exc}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print(f"error: invalid JSON in case file: {exc}", file=sys.stderr)
        return 2

    try:
        case = validate_case(data)
    except CaseError as exc:
        print(f"error: invalid case: {exc}", file=sys.stderr)
        return 2

    if args.budget < 0:
        print("error: --budget must be >= 0", file=sys.stderr)
        return 2

    try:
        result = minimize_case(case, args.budget)
    except CaseError as exc:
        print(f"error: invalid case: {exc}", file=sys.stderr)
        return 2

    text = json.dumps(result, indent=2) + "\n"
    if args.out:
        try:
            with open(args.out, "w", encoding="utf-8") as handle:
                handle.write(text)
        except OSError as exc:
            print(f"error: cannot write output file: {exc}", file=sys.stderr)
            return 2
    else:
        sys.stdout.write(text)
    return 0


def main(argv=None):
    args = _build_parser().parse_args(argv)
    if args.command == "minimize":
        return _cmd_minimize(args)
    return 2
