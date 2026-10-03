"""Command line interface: ``python -m sessionize --in e.jsonl --gap 30000 --late 5000``."""

from __future__ import annotations

import argparse
import json
import sys

from . import Sessionizer


def _error(msg):
    print(f"sessionize: error: {msg}", file=sys.stderr)


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="python -m sessionize",
        description="Sessionize a JSONL stream of {key, ts, id} events.",
    )
    parser.add_argument("--in", dest="input", required=True, metavar="FILE",
                        help="input JSONL file ('-' reads stdin)")
    parser.add_argument("--out", dest="output", default=None, metavar="FILE",
                        help="output JSONL file (default: stdout)")
    parser.add_argument("--gap", type=float, required=True, metavar="MS",
                        help="inactivity gap; adjacent events <= gap merge")
    parser.add_argument("--late", type=float, required=True, metavar="MS",
                        help="allowed lateness; watermark = max ts - late")
    args = parser.parse_args(argv)

    try:
        fin = sys.stdin if args.input == "-" else open(
            args.input, "r", encoding="utf-8")
    except OSError as exc:
        _error(f"cannot open input {args.input!r}: {exc}")
        return 2

    fout = sys.stdout
    if args.output is not None:
        try:
            fout = open(args.output, "w", encoding="utf-8")
        except OSError as exc:
            _error(f"cannot open output {args.output!r}: {exc}")
            if fin is not sys.stdin:
                fin.close()
            return 2

    sz = Sessionizer(gap=args.gap, late=args.late)
    try:
        for lineno, raw in enumerate(fin, 1):
            line = raw.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError as exc:
                _error(f"line {lineno}: invalid JSON: {exc}")
                return 2
            if not isinstance(rec, dict):
                _error(f"line {lineno}: expected a JSON object")
                return 2
            missing = [f for f in ("key", "ts", "id") if rec.get(f) is None]
            if missing:
                _error(f"line {lineno}: missing or null field(s): "
                       + ", ".join(missing))
                return 2
            key = rec["key"]
            if isinstance(key, bool) or not isinstance(key, (str, int, float)):
                _error(f"line {lineno}: key must be a string or number")
                return 2
            ts = rec["ts"]
            if isinstance(ts, bool) or not isinstance(ts, (int, float)):
                _error(f"line {lineno}: ts must be a number")
                return 2
            for record in sz.add(key, ts, rec["id"]):
                fout.write(json.dumps(record, ensure_ascii=False) + "\n")
    finally:
        if fin is not sys.stdin:
            fin.close()
        if fout is not sys.stdout:
            fout.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
