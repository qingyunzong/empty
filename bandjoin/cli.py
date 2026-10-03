"""Command line interface for the bandjoin package.

Usage:
    python -m bandjoin --left L.jsonl --right R.jsonl --bound 5000 --out pairs.jsonl

The two input files are consumed as streams in round-robin order (one left
line, one right line, ... until both are exhausted), which deterministically
interleaves the two arrival sequences.  Output is written only after both
inputs were fully validated and processed, via an atomic rename, so a failed
run never leaves a partial output file behind.

Exit codes: 0 = success, 2 = invalid input (bad line, unreadable file,
bad arguments), 1 = output could not be written.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import tempfile

from .core import BandJoin


class InputError(Exception):
    """Raised for any malformed input line."""


def _reject_constant(value):
    raise ValueError(f"invalid JSON constant {value!r}")


def _check_id_or_key(value, field, lineno, side):
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise InputError(
            f"{side}:{lineno}: field {field!r} must be a string or integer, "
            f"got {type(value).__name__}"
        )
    return value


def parse_line(line, lineno, side):
    """Parse and validate one JSONL line into an (id, key, ts) triple."""
    try:
        obj = json.loads(line, parse_constant=_reject_constant)
    except ValueError as exc:
        raise InputError(f"{side}:{lineno}: invalid JSON: {exc}") from exc
    if not isinstance(obj, dict):
        raise InputError(f"{side}:{lineno}: line must be a JSON object")
    for field in ("id", "key", "ts"):
        if field not in obj:
            raise InputError(f"{side}:{lineno}: missing field {field!r}")
    ident = _check_id_or_key(obj["id"], "id", lineno, side)
    key = _check_id_or_key(obj["key"], "key", lineno, side)
    ts = obj["ts"]
    if isinstance(ts, bool) or not isinstance(ts, (int, float)):
        raise InputError(
            f"{side}:{lineno}: field 'ts' must be a number, "
            f"got {type(ts).__name__}"
        )
    if not math.isfinite(ts):
        raise InputError(f"{side}:{lineno}: field 'ts' must be finite")
    return ident, key, ts


def read_stream(path, side):
    events = []
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for lineno, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                events.append(parse_line(line, lineno, side))
    except UnicodeDecodeError as exc:
        raise InputError(f"{side}: file is not valid UTF-8: {exc}") from exc
    return events


def run_join(left_events, right_events, bound, left_skew=0, right_skew=0):
    """Feed both streams round-robin into a BandJoin and finalize it."""
    joiner = BandJoin(bound, left_skew=left_skew, right_skew=right_skew)
    index = 0
    while index < len(left_events) or index < len(right_events):
        if index < len(left_events):
            joiner.add_left(*left_events[index])
        if index < len(right_events):
            joiner.add_right(*right_events[index])
        index += 1
    return joiner


def write_output(path, pairs):
    """Write pairs as JSONL atomically (temp file + rename)."""
    out_dir = os.path.dirname(os.path.abspath(path))
    fd, tmp_path = tempfile.mkstemp(
        dir=out_dir, prefix=".bandjoin-", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            for pair in pairs:
                handle.write(json.dumps(pair, ensure_ascii=False) + "\n")
        os.replace(tmp_path, path)
    except OSError:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def build_parser():
    parser = argparse.ArgumentParser(
        prog="bandjoin",
        description="Band join two JSONL event streams with watermarks.",
    )
    parser.add_argument("--left", required=True, help="left input JSONL file")
    parser.add_argument("--right", required=True, help="right input JSONL file")
    parser.add_argument(
        "--bound",
        required=True,
        type=float,
        help="maximum |l.ts - r.ts| for a match (inclusive, >= 0)",
    )
    parser.add_argument("--out", required=True, help="output JSONL file")
    parser.add_argument(
        "--left-skew", type=float, default=0, help="left watermark skew"
    )
    parser.add_argument(
        "--right-skew", type=float, default=0, help="right watermark skew"
    )
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.bound < 0:
        parser.error("--bound must be >= 0")
    if args.left_skew < 0 or args.right_skew < 0:
        parser.error("skews must be >= 0")

    try:
        left_events = read_stream(args.left, "left")
        right_events = read_stream(args.right, "right")
    except InputError as exc:
        print(f"bandjoin: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"bandjoin: cannot read input: {exc}", file=sys.stderr)
        return 2

    joiner = run_join(
        left_events,
        right_events,
        args.bound,
        left_skew=args.left_skew,
        right_skew=args.right_skew,
    )
    pairs = joiner.finalize()

    try:
        write_output(args.out, pairs)
    except OSError as exc:
        print(f"bandjoin: cannot write output: {exc}", file=sys.stderr)
        return 1

    stats = dict(joiner.stats)
    stats["pairs"] = len(pairs)
    print(json.dumps(stats, sort_keys=True), file=sys.stderr)
    return 0
