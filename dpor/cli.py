"""Command line interface: python -m dpor explore program.json ..."""

from __future__ import annotations

import argparse
import json
import sys

from .core import ProgramError, parse_program
from .explore import explore


def _cmd_explore(args) -> int:
    try:
        with open(args.program, "r", encoding="utf-8") as fh:
            obj = json.load(fh)
    except OSError as exc:
        print(f"dpor: cannot read {args.program}: {exc}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print(f"dpor: invalid JSON in {args.program}: {exc}", file=sys.stderr)
        return 2
    try:
        program = parse_program(obj)
    except ProgramError as exc:
        print(f"dpor: invalid program: {exc}", file=sys.stderr)
        return 2
    if args.max_schedules < 1:
        print("dpor: --max-schedules must be >= 1", file=sys.stderr)
        return 2
    result = explore(program, max_schedules=args.max_schedules)
    text = json.dumps(result.report(), indent=2)
    if args.out:
        try:
            with open(args.out, "w", encoding="utf-8") as fh:
                fh.write(text + "\n")
        except OSError as exc:
            print(f"dpor: cannot write {args.out}: {exc}", file=sys.stderr)
            return 2
    print(text)
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="dpor",
        description="Explore non-equivalent thread interleavings with "
                    "dynamic partial-order reduction.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    p_explore = sub.add_parser("explore", help="explore all non-equivalent schedules")
    p_explore.add_argument("program", help="path to the program JSON file")
    p_explore.add_argument("--max-schedules", type=int, default=10000,
                           help="stop after this many schedules (default: 10000)")
    p_explore.add_argument("--out", default=None, help="also write the report JSON here")
    args = parser.parse_args(argv)
    if args.command == "explore":
        return _cmd_explore(args)
    return 2
