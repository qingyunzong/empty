"""Command line interface: python -m merklesync diff A B --max-rounds R."""

from __future__ import annotations

import argparse
import json
import sys

from .core import (
    EXIT_ORDER_ERROR,
    InputError,
    OrderError,
    load_stream,
    merkle_diff,
)

EXIT_USAGE_ERROR = 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="merklesync",
        description="Diff two ordered key-value JSONL streams with bounded-round "
        "Merkle interval synchronization.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    diff = sub.add_parser("diff", help="diff two sorted JSONL key-value files")
    diff.add_argument("a", help="path to the first (left) JSONL file")
    diff.add_argument("b", help="path to the second (right) JSONL file")
    diff.add_argument(
        "--max-rounds",
        type=int,
        default=64,
        metavar="R",
        help="maximum number of hash-exchange rounds before reporting "
        "incomplete (default: 64)",
    )
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "diff":
        if args.max_rounds < 1:
            print("error: --max-rounds must be >= 1", file=sys.stderr)
            return EXIT_USAGE_ERROR
        try:
            stream_a = load_stream(args.a)
            stream_b = load_stream(args.b)
        except OrderError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return EXIT_ORDER_ERROR
        except InputError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return EXIT_USAGE_ERROR
        result = merkle_diff(stream_a, stream_b, args.max_rounds)
        json.dump(result, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0
    return EXIT_USAGE_ERROR
