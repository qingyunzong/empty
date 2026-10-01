"""Command line interface: python -m shrink minimize case.json --budget N --out out.json"""

import argparse
import json
import sys

from .case import CaseError, parse_case
from .minimize import minimize


def _build_parser():
    parser = argparse.ArgumentParser(
        prog="shrink",
        description="Budget-limited failing-test-case minimizer.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    m = sub.add_parser("minimize", help="minimize a case file")
    m.add_argument("case", help="path to the case JSON file")
    m.add_argument("--budget", type=int, default=1000,
                   help="maximum number of predicate checks (default: 1000)")
    m.add_argument("--out", default=None,
                   help="write result JSON here (default: stdout)")
    return parser


def main(argv=None):
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.budget < 0:
        parser.error("--budget must be >= 0")  # exits 2

    try:
        with open(args.case, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except OSError as exc:
        print("error: cannot read case file: %s" % exc, file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print("error: case file is not valid JSON: %s" % exc, file=sys.stderr)
        return 2

    try:
        ops, predicate = parse_case(data)
    except CaseError as exc:
        print("error: invalid case: %s" % exc, file=sys.stderr)
        return 2

    result = minimize(ops, predicate, args.budget)
    text = json.dumps(result.to_dict(), indent=2, ensure_ascii=False)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
