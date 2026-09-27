"""Command line interface: ``python -m budgetsync plan A B --budget N --out P``."""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, List, Optional, Sequence

from .core import (
    BudgetError,
    NotAnObjectError,
    apply_plan,
    build_plan,
)


def _load_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _write_plan(path: str, plan: List[dict]) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        for operation in plan:
            handle.write(json.dumps(operation, sort_keys=True, ensure_ascii=False))
            handle.write("\n")


def _cmd_plan(args: argparse.Namespace) -> int:
    # Exit code 2: negative budget is checked against the parsed value before
    # touching the input files.
    if args.budget < 0:
        print("budgetsync: budget must be non-negative", file=sys.stderr)
        return 2

    target = _load_json(args.a)
    current = _load_json(args.b)

    # Exit code 3: either state is not a JSON object.
    if not isinstance(target, dict) or not isinstance(current, dict):
        print("budgetsync: A and B must both be JSON objects", file=sys.stderr)
        return 3

    plan, info = build_plan(target, current, args.budget)
    _write_plan(args.out, plan)
    print(json.dumps(info, sort_keys=True))
    return 0


def _load_plan(path: str) -> List[dict]:
    operations: List[dict] = []
    with open(path, "r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            operation = json.loads(line)
            if not isinstance(operation, dict):
                raise ValueError(f"plan line {line_number} is not an object")
            operations.append(operation)
    return operations


def _cmd_apply(args: argparse.Namespace) -> int:
    state = _load_json(args.state)
    if not isinstance(state, dict):
        print("budgetsync: state must be a JSON object", file=sys.stderr)
        return 3
    plan = _load_plan(args.plan)
    result = apply_plan(state, plan)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(result, handle, sort_keys=True, ensure_ascii=False, indent=2)
        handle.write("\n")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m budgetsync",
        description="Generate a budgeted plan that converges B toward A.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    plan_parser = subparsers.add_parser(
        "plan", help="generate an operation plan (JSONL) converging B to A"
    )
    plan_parser.add_argument("a", help="path to target state JSON (A)")
    plan_parser.add_argument("b", help="path to current state JSON (B)")
    plan_parser.add_argument(
        "--budget", required=True, type=int, help="maximum number of operations"
    )
    plan_parser.add_argument(
        "--out", required=True, help="path to write the JSONL plan"
    )
    plan_parser.set_defaults(func=_cmd_plan)

    apply_parser = subparsers.add_parser(
        "apply", help="apply a JSONL plan to a state JSON file"
    )
    apply_parser.add_argument("plan", help="path to the JSONL plan")
    apply_parser.add_argument("state", help="path to the current state JSON")
    apply_parser.add_argument("--out", required=True, help="path for the result")
    apply_parser.set_defaults(func=_cmd_apply)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(f"budgetsync: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
