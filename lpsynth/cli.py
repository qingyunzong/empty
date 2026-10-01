"""Command line interface: python -m lpsynth solve history.json --type stack --timeout-ms 2000"""
from __future__ import annotations

import argparse
import json
import sys

from .model import HistoryError, parse_history
from .solver import INFEASIBLE, OK, TIMEOUT, UNKNOWN, solve

EXIT_OK = 0
EXIT_INFEASIBLE = 1
EXIT_INVALID = 2
EXIT_UNKNOWN = 3
EXIT_TIMEOUT = 6

_STATUS_EXIT = {
    OK: EXIT_OK,
    INFEASIBLE: EXIT_INFEASIBLE,
    UNKNOWN: EXIT_UNKNOWN,
    TIMEOUT: EXIT_TIMEOUT,
}


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="lpsynth",
        description="Compute feasible linearization-point intervals for a "
                    "concurrent history.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    solve_parser = sub.add_parser("solve", help="solve a history file")
    solve_parser.add_argument("history", help="path to a JSON history file")
    solve_parser.add_argument("--type", default="stack", choices=["stack"],
                              help="object type of the history (default: stack)")
    solve_parser.add_argument("--timeout-ms", type=int, default=1000,
                              help="solver time budget in milliseconds (default: 1000)")
    return parser


def main(argv=None) -> int:
    args = _build_parser().parse_args(argv)
    if args.timeout_ms < 0:
        print("error: --timeout-ms must be >= 0", file=sys.stderr)
        return EXIT_INVALID
    try:
        with open(args.history, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        ops = parse_history(data)
    except (OSError, json.JSONDecodeError, HistoryError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INVALID

    result = solve(ops, args.timeout_ms)
    output = {
        "status": result.status,
        "intervals": result.intervals,
        "conflict": result.conflict,
    }
    json.dump(output, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return _STATUS_EXIT[result.status]
