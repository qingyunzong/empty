"""CLI: python -m dedupwin --in e.jsonl --skew 10000 --ret 60000

Reads JSONL records {"id", "key", "ts", "val"}, emits deduplicated records
with ts >= L (L = max_ts - skew - ret) to stdout as JSONL sorted by (ts, id).
Statistics are printed to stderr as a single JSON line.

Exit codes: 0 on success, 2 on input errors (missing id/ts, bad JSON, IO).
"""

from __future__ import annotations

import argparse
import json
import sys

from .core import DedupWin, MissingFieldError


def _build_parser():
    parser = argparse.ArgumentParser(
        prog="dedupwin",
        description="Bounded-skew streaming dedup over event-time windows.",
    )
    parser.add_argument("--in", dest="input", required=True,
                        help="input JSONL file ('-' for stdin)")
    parser.add_argument("--skew", type=int, required=True,
                        help="global max-ts-difference bound across sources")
    parser.add_argument("--ret", type=int, required=True,
                        help="retention horizon below max_ts - skew")
    return parser


def main(argv=None):
    args = _build_parser().parse_args(argv)
    if args.skew < 0 or args.ret < 0:
        print("error: --skew and --ret must be non-negative", file=sys.stderr)
        return 2

    dwin = DedupWin(skew=args.skew, ret=args.ret)
    try:
        stream = sys.stdin if args.input == "-" else open(
            args.input, "r", encoding="utf-8")
        with stream:
            for lineno, line in enumerate(stream, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as exc:
                    print(f"error: line {lineno}: invalid JSON: {exc}",
                          file=sys.stderr)
                    return 2
                try:
                    dwin.add(record)
                except MissingFieldError as exc:
                    print(f"error: line {lineno}: {exc}", file=sys.stderr)
                    return 2
    except OSError as exc:
        print(f"error: cannot read {args.input!r}: {exc}", file=sys.stderr)
        return 2

    for record in dwin.results():
        print(json.dumps(record, ensure_ascii=False, sort_keys=True))
    print(json.dumps(dwin.stats(), sort_keys=True), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
