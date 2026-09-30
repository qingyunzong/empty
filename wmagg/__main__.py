"""CLI entry point.

Usage:
    python -m wmagg --input events.jsonl --out out.jsonl [--late late.jsonl]
        --window W --out-of-order S --idle-timeout I
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import List, Optional

from .core import InputError, WindowAggregator, parse_event


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="wmagg",
        description="Watermark-based rolling-window aggregation over JSONL events.",
    )
    parser.add_argument(
        "--input",
        required=True,
        help="input JSONL file, one {src, ts, key, val} object per line",
    )
    parser.add_argument(
        "--out",
        required=True,
        help="output JSONL file for finalised windows "
        '({"start", "end", "key", "sum"} per line)',
    )
    parser.add_argument(
        "--late",
        default="late.jsonl",
        help="output JSONL file for late events (default: late.jsonl)",
    )
    parser.add_argument(
        "--window", type=int, required=True, metavar="W",
        help="window length in ms (> 0)",
    )
    parser.add_argument(
        "--out-of-order", type=int, required=True, metavar="S",
        help="allowed out-of-orderness in ms (>= 0)",
    )
    parser.add_argument(
        "--idle-timeout", type=int, required=True, metavar="I",
        help="source idle timeout in ms (>= 0)",
    )
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    if args.window <= 0:
        print("wmagg: error: --window must be > 0", file=sys.stderr)
        return 2
    if args.out_of_order < 0:
        print("wmagg: error: --out-of-order must be >= 0", file=sys.stderr)
        return 2
    if args.idle_timeout < 0:
        print("wmagg: error: --idle-timeout must be >= 0", file=sys.stderr)
        return 2

    agg = WindowAggregator(args.window, args.out_of_order, args.idle_timeout)
    try:
        with open(args.input, "r", encoding="utf-8") as fh:
            for lineno, line in enumerate(fh, 1):
                if not line.strip():
                    continue
                agg.process(parse_event(line, lineno))
    except InputError as exc:
        print(f"wmagg: error: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"wmagg: error: cannot read {args.input!r}: {exc}", file=sys.stderr)
        return 2

    # Outputs are buffered and written only after the whole input validated,
    # so a failed run never leaves partial results behind.
    try:
        with open(args.out, "w", encoding="utf-8") as fh:
            for rec in agg.outputs:
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        with open(args.late, "w", encoding="utf-8") as fh:
            for ev in agg.lates:
                fh.write(json.dumps(ev.as_dict(), ensure_ascii=False) + "\n")
    except OSError as exc:
        print(f"wmagg: error: cannot write output: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
