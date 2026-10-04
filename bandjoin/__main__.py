"""CLI: python -m bandjoin --left L.jsonl --right R.jsonl --bound 5000 --out pairs.jsonl

The two streams are replayed merged by event timestamp (ties: left before
right, then file order), which models arrival roughly in event-time order.
All input is validated before anything is written; on any bad line the
command exits with code 2 and the output file is never created or modified.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from . import BandJoin, InputError, load_stream


def _non_negative(text):
    try:
        value = float(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a number: {text!r}")
    if value != value or value < 0 or value in (float("inf"), float("-inf")):
        raise argparse.ArgumentTypeError(f"must be a finite non-negative number: {text!r}")
    if value.is_integer():
        return int(value)
    return value


def _build_parser():
    parser = argparse.ArgumentParser(
        prog="bandjoin",
        description="Temporal band join of two JSONL event streams.",
    )
    parser.add_argument("--left", required=True, help="left input JSONL file")
    parser.add_argument("--right", required=True, help="right input JSONL file")
    parser.add_argument("--bound", required=True, type=_non_negative,
                        help="max |ts_l - ts_r| for a match (0 requires equal ts)")
    parser.add_argument("--left-skew", type=_non_negative, default=0,
                        help="left watermark skew (default 0)")
    parser.add_argument("--right-skew", type=_non_negative, default=0,
                        help="right watermark skew (default 0)")
    parser.add_argument("--out", required=True, help="output JSONL file")
    return parser


def _merge_by_ts(left, right):
    tagged = [(ev["ts"], 0, idx, "L", ev) for idx, ev in enumerate(left)]
    tagged += [(ev["ts"], 1, idx, "R", ev) for idx, ev in enumerate(right)]
    tagged.sort(key=lambda item: (item[0], item[1], item[2]))
    return [(side, ev) for _, _, _, side, ev in tagged]


def main(argv=None):
    args = _build_parser().parse_args(argv)
    try:
        left = load_stream(args.left, name="left")
        right = load_stream(args.right, name="right")
    except InputError as exc:
        print(f"bandjoin: {exc}", file=sys.stderr)
        return 2

    join = BandJoin(args.bound, left_skew=args.left_skew, right_skew=args.right_skew)
    for side, event in _merge_by_ts(left, right):
        join.add(side, event)
    pairs = join.finalise()

    tmp_path = args.out + ".tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as fh:
            for pair in pairs:
                fh.write(json.dumps(pair, ensure_ascii=False) + "\n")
        os.replace(tmp_path, args.out)
    except OSError as exc:
        print(f"bandjoin: cannot write output: {exc}", file=sys.stderr)
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        return 1

    print(json.dumps(join.stats(), ensure_ascii=False), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
