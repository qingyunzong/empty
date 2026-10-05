"""CLI: python -m latefix --in e.jsonl --win 30000 --late 10000 [--out out.jsonl]"""

from __future__ import annotations

import argparse
import json
import sys

from .core import Engine, LatefixError


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="latefix",
        description="Emit ADD/RETRACT change streams for rolling windows with lateness.",
    )
    parser.add_argument("--in", dest="infile", required=True, help="input JSONL of {key,ts,val}")
    parser.add_argument("--win", type=int, required=True, help="window size (ms)")
    parser.add_argument("--late", type=int, required=True, help="allowed lateness (ms)")
    parser.add_argument("--out", dest="outfile", default=None, help="output JSONL (default: stdout)")
    args = parser.parse_args(argv)

    try:
        engine = Engine(args.win, args.late)
    except ValueError as exc:
        print(f"latefix: {exc}", file=sys.stderr)
        return 2

    out = open(args.outfile, "w", encoding="utf-8") if args.outfile else sys.stdout
    try:
        with open(args.infile, "r", encoding="utf-8") as fh:
            for lineno, line in enumerate(fh, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError as exc:
                    print(f"latefix: line {lineno}: invalid JSON: {exc}", file=sys.stderr)
                    return 2
                try:
                    records = engine.process(rec)
                except LatefixError as exc:
                    print(f"latefix: line {lineno}: {exc}", file=sys.stderr)
                    return 2
                for record in records:
                    out.write(json.dumps(record, separators=(",", ":")) + "\n")
        out.flush()
    except FileNotFoundError:
        print(f"latefix: no such file: {args.infile}", file=sys.stderr)
        return 2
    finally:
        if out is not sys.stdout:
            out.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
