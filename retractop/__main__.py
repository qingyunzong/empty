"""CLI: python -m retractop --in ops.jsonl --k 3 --win 60000 [--allowed-lateness MS] [--out FILE]

Reads JSONL ops, writes TopK diff records as JSONL to stdout (or --out),
prints a summary {"invalid": N, "dropped": M} to stderr.  Exit code 2 on a
malformed input line; unknown ops are counted invalid and do not abort.
"""

from __future__ import annotations

import argparse
import json
import sys

from .core import Engine, ParseError, parse_line


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="retractop")
    parser.add_argument("--in", dest="input", required=True, help="input JSONL file")
    parser.add_argument("--k", type=int, required=True, help="top-K size")
    parser.add_argument("--win", type=int, required=True, help="window size (ms)")
    parser.add_argument(
        "--allowed-lateness",
        type=int,
        default=0,
        help="allowed lateness for corrections of final windows (ms)",
    )
    parser.add_argument("--out", dest="output", default=None, help="output file (default: stdout)")
    args = parser.parse_args(argv)

    try:
        engine = Engine(k=args.k, win=args.win, allowed_lateness=args.allowed_lateness)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    try:
        infile = open(args.input, "r", encoding="utf-8")
    except OSError as exc:
        print(f"error: cannot open input: {exc}", file=sys.stderr)
        return 2

    out = sys.stdout if args.output is None else open(args.output, "w", encoding="utf-8")
    try:
        with infile:
            for lineno, raw in enumerate(infile, 1):
                line = raw.strip()
                if not line:
                    continue
                try:
                    event = parse_line(line)
                except ParseError as exc:
                    print(f"error: line {lineno}: {exc}", file=sys.stderr)
                    return 2
                engine.process(event)
        engine.finish()
        for record in engine.out:
            out.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
        out.flush()
        print(
            json.dumps({"invalid": engine.invalid, "dropped": engine.dropped}),
            file=sys.stderr,
        )
        return 0
    finally:
        if out is not sys.stdout:
            out.close()


if __name__ == "__main__":
    sys.exit(main())
