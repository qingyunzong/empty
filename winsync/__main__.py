"""Command line interface: python -m winsync pull SRC DST --win W --ack ACK"""

from __future__ import annotations

import argparse
import json
import sys

from .core import PullError, pull

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_QUARANTINE = 7


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="winsync",
        description="Pull records from a read-only segment log into a JSONL file.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("pull", help="pull records from SRC into DST")
    p.add_argument("src", help="source directory containing .seg files")
    p.add_argument("dst", help="destination JSONL file")
    p.add_argument("--win", type=int, default=1,
                   help="sliding validation window size (default: 1)")
    p.add_argument("--ack", required=True,
                   help="path to the ACK watermark file used for recovery")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "pull":
        try:
            result = pull(args.src, args.dst, args.ack, window=args.win)
        except PullError as exc:
            print(f"winsync: error: {exc}", file=sys.stderr)
            return EXIT_ERROR
        except OSError as exc:
            print(f"winsync: error: {exc}", file=sys.stderr)
            return EXIT_ERROR
        print(json.dumps({
            "high_watermark": result.high_watermark,
            "quarantined": result.quarantined,
            "committed": result.committed,
            "resumed_from": result.resumed_from,
            "dst": result.dst,
        }, ensure_ascii=False))
        if result.quarantined:
            print(
                "winsync: quarantined corrupt segment(s) "
                f"{result.quarantined}; commit halted at "
                f"high_watermark={result.high_watermark}",
                file=sys.stderr,
            )
            return EXIT_QUARANTINE
        return EXIT_OK
    return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
