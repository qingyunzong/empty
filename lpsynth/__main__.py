"""CLI: python -m lpsynth solve history.json --type stack --timeout-ms 2000"""

from __future__ import annotations

import argparse
import json
import sys

from .history import load_history, HistoryError, SUPPORTED_TYPES
from .solver import solve

EXIT_OK = 0
EXIT_INVALID = 2
EXIT_TIMEOUT = 6


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="lpsynth",
        description="Synthesize feasible linearization-point intervals "
        "for concurrent histories.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    solve_parser = sub.add_parser(
        "solve", help="check a history and report per-operation LP intervals"
    )
    solve_parser.add_argument("file", help="path to the history JSON file")
    solve_parser.add_argument(
        "--type",
        default="stack",
        choices=list(SUPPORTED_TYPES),
        help="object type of the history (default: stack)",
    )
    solve_parser.add_argument(
        "--timeout-ms",
        type=int,
        default=10000,
        help="solver time budget in milliseconds (default: 10000)",
    )
    return parser


def main(argv=None) -> int:
    args = _build_parser().parse_args(argv)
    if args.command == "solve":
        if args.timeout_ms < 0:
            print("error: --timeout-ms must be >= 0", file=sys.stderr)
            return EXIT_INVALID
        try:
            with open(args.file, "r", encoding="utf-8") as fh:
                text = fh.read()
        except OSError as exc:
            print(f"error: cannot read {args.file}: {exc}", file=sys.stderr)
            return EXIT_INVALID
        try:
            ops = load_history(text, expected_type=args.type)
        except HistoryError as exc:
            print(f"error: invalid history: {exc}", file=sys.stderr)
            return EXIT_INVALID
        result = solve(ops, args.timeout_ms)
        json.dump(result.to_dict(), sys.stdout, indent=2, sort_keys=False)
        sys.stdout.write("\n")
        return EXIT_TIMEOUT if result.status == "TIMEOUT" else EXIT_OK
    return EXIT_INVALID


if __name__ == "__main__":
    sys.exit(main())
