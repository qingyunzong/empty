"""Command line interface: python -m winsync pull SRC DST --win W --ack ACK"""

from __future__ import annotations

import argparse
import json
import sys

from .core import WinsyncError, pull

EXIT_OK = 0
EXIT_ERROR = 2
EXIT_QUARANTINED = 7


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="winsync",
        description="Pull records from read-only segment logs with a sliding window.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    pull_parser = sub.add_parser("pull", help="pull records from SRC into DST")
    pull_parser.add_argument("src", help="source directory containing .seg files")
    pull_parser.add_argument("dst", help="destination JSONL file")
    pull_parser.add_argument("--win", type=int, default=8,
                             help="sliding window size (default: 8)")
    pull_parser.add_argument("--ack", required=True, help="ACK state file path")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "pull":
        if args.win < 1:
            print("error: --win must be >= 1", file=sys.stderr)
            return EXIT_ERROR
        try:
            result = pull(args.src, args.dst, args.ack, window=args.win)
        except WinsyncError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return EXIT_ERROR
        except OSError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return EXIT_ERROR
        print(json.dumps(result))
        return EXIT_QUARANTINED if result["quarantined"] else EXIT_OK
    return EXIT_ERROR


if __name__ == "__main__":
    raise SystemExit(main())
