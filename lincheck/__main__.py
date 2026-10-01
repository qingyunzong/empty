"""CLI: python -m lincheck verify history.json --impl register|queue --max-states N"""
from __future__ import annotations

import argparse
import json
import sys

from .core import InvalidHistory, Verdict, parse_history, verify

EXIT_OK = 0
EXIT_NON_LINEARIZABLE = 1
EXIT_INVALID = 2
EXIT_UNKNOWN = 5

_EXIT_CODES = {
    Verdict.LINEARIZABLE: EXIT_OK,
    Verdict.NON_LINEARIZABLE: EXIT_NON_LINEARIZABLE,
    Verdict.UNKNOWN: EXIT_UNKNOWN,
    Verdict.UNKNOWN_RESOURCE: EXIT_UNKNOWN,
}


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="lincheck",
        description="Linearizability checker for concurrent histories.")
    sub = parser.add_subparsers(dest="command", required=True)
    verify_parser = sub.add_parser("verify", help="verify a history file")
    verify_parser.add_argument("history", help="path to a JSON history file")
    verify_parser.add_argument("--impl", choices=["register", "queue"],
                               required=True, help="object implementation")
    verify_parser.add_argument("--max-states", type=int, default=100_000,
                               help="state-exploration budget (default 100000)")
    return parser


def main(argv=None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.max_states <= 0:
        print("error: --max-states must be a positive integer", file=sys.stderr)
        return EXIT_INVALID

    try:
        with open(args.history, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except OSError as exc:
        print(f"error: cannot read history file: {exc}", file=sys.stderr)
        return EXIT_INVALID
    except json.JSONDecodeError as exc:
        print(f"error: invalid JSON: {exc}", file=sys.stderr)
        return EXIT_INVALID

    try:
        ops, initial = parse_history(data, args.impl)
        result = verify(ops, args.impl, max_states=args.max_states,
                        initial=initial)
    except InvalidHistory as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INVALID

    print(result.verdict.value)
    print(json.dumps(result.to_dict(), indent=2, default=str))
    return _EXIT_CODES[result.verdict]


if __name__ == "__main__":
    sys.exit(main())
