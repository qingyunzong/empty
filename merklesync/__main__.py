"""CLI: python -m merklesync diff A B --max-rounds R"""

from __future__ import annotations

import argparse
import json
import sys

from . import OrderError, ParseError, diff_streams, load_stream


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="merklesync",
        description="Diff two sorted JSONL key-value streams via Merkle "
                    "interval bisection.")
    sub = parser.add_subparsers(dest="command", required=True)
    diff_parser = sub.add_parser("diff", help="diff two streams")
    diff_parser.add_argument("a", help="path to stream A (JSONL)")
    diff_parser.add_argument("b", help="path to stream B (JSONL)")
    diff_parser.add_argument("--max-rounds", type=int, default=32,
                             help="maximum hash-exchange rounds (default: 32)")
    args = parser.parse_args(argv)

    if args.max_rounds < 0:
        print("error: --max-rounds must be >= 0", file=sys.stderr)
        return 2

    try:
        stream_a = load_stream(args.a)
        stream_b = load_stream(args.b)
    except OrderError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 3
    except (ParseError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    result = diff_streams(stream_a, stream_b, args.max_rounds)
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
