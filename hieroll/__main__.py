"""CLI: python -m hieroll --in events.jsonl --out roll.jsonl [--late SECONDS]"""

import argparse
import json
import sys

from . import HierRoll


def _check_int(value, field):
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{field} must be an integer, got {value!r}")
    return value


def main(argv=None):
    parser = argparse.ArgumentParser(prog="hieroll")
    parser.add_argument("--in", dest="inp", required=True, help="input JSONL")
    parser.add_argument("--out", dest="out", required=True, help="output JSONL")
    parser.add_argument("--late", type=int, default=0,
                        help="allowed lateness in seconds (default 0)")
    args = parser.parse_args(argv)

    roll = HierRoll(late=args.late)
    try:
        with open(args.inp, encoding="utf-8") as fin, \
                open(args.out, "w", encoding="utf-8") as fout:
            for lineno, line in enumerate(fin, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                    key = event["key"]
                    ts = _check_int(event["ts"], "ts")
                    delta = _check_int(event["delta"], "delta")
                except (ValueError, KeyError, TypeError) as exc:
                    raise ValueError(f"line {lineno}: {exc}") from exc
                for record in roll.add(key, ts, delta):
                    fout.write(json.dumps(record, ensure_ascii=False) + "\n")
    except (ValueError, OSError) as exc:
        print(f"hieroll: error: {exc}", file=sys.stderr)
        return 2
    print(f"dropped={roll.dropped}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
