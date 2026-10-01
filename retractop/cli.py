"""Command line interface: python -m retractop --in ops.jsonl --k 3 --win 60000"""

from __future__ import annotations

import argparse
import json
import sys

from .core import BadLineError, Engine, parse_event


def _build_parser():
    parser = argparse.ArgumentParser(
        prog="retractop",
        description="Event-time windowed Top-K with add/retract semantics.",
    )
    parser.add_argument("--in", dest="input", required=True,
                        help="input JSONL file of events")
    parser.add_argument("--k", dest="k", type=int, required=True,
                        help="number of top rows per window")
    parser.add_argument("--win", dest="win", type=float, required=True,
                        help="window size in event-time units (ms)")
    parser.add_argument("--lateness", dest="lateness", type=float, default=0,
                        help="allowed lateness for corrections to final windows")
    return parser


def main(argv=None):
    args = _build_parser().parse_args(argv)
    try:
        engine = Engine(k=args.k, win=args.win, lateness=args.lateness)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    try:
        stream = open(args.input, "r", encoding="utf-8")
    except OSError as exc:
        print(f"error: cannot open {args.input}: {exc}", file=sys.stderr)
        return 2

    emitted = 0

    def emit(record):
        nonlocal emitted
        emitted += 1
        print(json.dumps(record, ensure_ascii=False, sort_keys=True))

    with stream:
        for lineno, raw in enumerate(stream, 1):
            line = raw.strip()
            if not line:
                continue
            try:
                event = parse_event(line)
            except BadLineError as exc:
                print(f"error: line {lineno}: {exc}", file=sys.stderr)
                return 2
            for record in engine.process(event):
                emit(record)
    for record in engine.finish():
        emit(record)

    summary = {
        "invalid": engine.invalid,
        "dropped": engine.dropped,
        "emitted": emitted,
    }
    print(json.dumps(summary, sort_keys=True), file=sys.stderr)
    return 0
