"""CLI: python -m latefix --in e.jsonl --win 30000 --late 10000"""

from __future__ import annotations

import argparse
import json
import sys

from .core import run_stream
from .io import InputError, parse_line


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="latefix",
        description="Emit ADD/RETRACT change streams for rolling windows "
        "with bounded-lateness corrections.",
    )
    parser.add_argument("--in", dest="input", required=True,
                        help="input JSONL file of {key, ts, val} events")
    parser.add_argument("--win", type=int, required=True,
                        help="window size in milliseconds (positive)")
    parser.add_argument("--late", type=int, required=True,
                        help="allowed lateness in milliseconds (>= 0)")
    args = parser.parse_args(argv)

    if args.win <= 0:
        print("latefix: --win must be positive", file=sys.stderr)
        return 2
    if args.late < 0:
        print("latefix: --late must be non-negative", file=sys.stderr)
        return 2

    events = []
    try:
        with open(args.input, "r", encoding="utf-8") as handle:
            for lineno, line in enumerate(handle, 1):
                line = line.strip()
                if line:
                    events.append(parse_line(line, lineno))
    except InputError as exc:
        print(f"latefix: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"latefix: cannot read input: {exc}", file=sys.stderr)
        return 2

    out = sys.stdout
    for record in run_stream(events, args.win, args.late):
        out.write(json.dumps(record.to_dict(), ensure_ascii=False,
                             sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
