"""CLI: python -m hieroll --in e.jsonl --out roll.jsonl [--late SECONDS]

Input JSONL:  {"key": str, "ts": number, "delta": int}
Output JSONL: {"key", "layer", "start", "end", "sum", "version"}
Exit code 2 on invalid input (including a non-integer ``delta``).
"""

from __future__ import annotations

import argparse
import json
import sys

from .core import HierRoll


def _error(message: str) -> int:
    print(f"hieroll: {message}", file=sys.stderr)
    return 2


def _parse_event(obj, lineno):
    """Validate one decoded JSON value; return (key, ts, delta) or None."""
    if not isinstance(obj, dict):
        return None
    key = obj.get("key")
    ts = obj.get("ts")
    delta = obj.get("delta")
    if not isinstance(key, str):
        return None
    if isinstance(ts, bool) or not isinstance(ts, (int, float)):
        return None
    if isinstance(delta, bool) or not isinstance(delta, int):
        return None
    return key, ts, delta


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="hieroll")
    parser.add_argument("--in", dest="in_path", required=True, help="input JSONL path")
    parser.add_argument("--out", dest="out_path", required=True, help="output JSONL path")
    parser.add_argument("--late", type=float, default=0.0,
                        help="allowed lateness in seconds (default: 0)")
    args = parser.parse_args(argv)

    roll = HierRoll(late=args.late)
    emitted = 0
    try:
        fin = open(args.in_path, "r", encoding="utf-8")
    except OSError as exc:
        return _error(f"cannot open input: {exc}")
    try:
        fout = open(args.out_path, "w", encoding="utf-8")
    except OSError as exc:
        fin.close()
        return _error(f"cannot open output: {exc}")

    with fin, fout:
        for lineno, line in enumerate(fin, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                return _error(f"line {lineno}: invalid JSON")
            event = _parse_event(obj, lineno)
            if event is None:
                return _error(f"line {lineno}: expected "
                              '{"key": str, "ts": number, "delta": integer}')
            for record in roll.add(*event):
                fout.write(json.dumps(record.to_dict()) + "\n")
                emitted += 1
        for record in roll.close():
            fout.write(json.dumps(record.to_dict()) + "\n")
            emitted += 1

    print(json.dumps({"emitted": emitted, "dropped": roll.dropped}), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
