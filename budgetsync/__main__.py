"""CLI entry point: python -m budgetsync plan A B --budget N --out PLAN"""

from __future__ import annotations

import argparse
import json
import sys

from . import apply_plan, build_plan  # noqa: F401  (re-exported for convenience)
from . import needed_ops, select_ops

EXIT_OK = 0
EXIT_BAD_BUDGET = 2
EXIT_NOT_OBJECT = 3


def _load_json(path: str):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="budgetsync")
    subparsers = parser.add_subparsers(dest="command", required=True)
    plan_parser = subparsers.add_parser(
        "plan", help="plan ops converging JSON object B toward A"
    )
    plan_parser.add_argument("a", help="path to target JSON object A")
    plan_parser.add_argument("b", help="path to current JSON object B")
    plan_parser.add_argument("--budget", type=int, required=True, help="op budget N")
    plan_parser.add_argument("--out", required=True, help="output plan path (JSONL)")
    args = parser.parse_args(argv)

    if args.command == "plan":
        if args.budget < 0:
            print("error: budget must be >= 0", file=sys.stderr)
            return EXIT_BAD_BUDGET
        a = _load_json(args.a)
        b = _load_json(args.b)
        if not isinstance(a, dict) or not isinstance(b, dict):
            print("error: A and B must both be JSON objects", file=sys.stderr)
            return EXIT_NOT_OBJECT
        selected = select_ops(needed_ops(a, b), args.budget)
        with open(args.out, "w", encoding="utf-8") as handle:
            for op in selected:
                handle.write(
                    json.dumps(op, sort_keys=True, ensure_ascii=False) + "\n"
                )
        remaining = args.budget - len(selected)
        print(f"selected={len(selected)} budget={args.budget} remaining={remaining}")
        return EXIT_OK
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
