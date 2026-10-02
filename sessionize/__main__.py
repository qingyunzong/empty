"""CLI: python -m sessionize --in e.jsonl --gap 30000 --late 5000 [--out out.jsonl]

Reads JSONL events of the form {"key": ..., "ts": ..., "id": ...} and writes
one JSON object per output record to stdout (or --out):

    {"type": "ADD", "session": {"key", "start", "end", "count", "ids"}}
    {"type": "RETRACT", "session": {...}}

Exit codes: 0 on success, 1 on I/O errors, 2 on malformed input records
(including a missing "id" field).
"""

from __future__ import annotations

import argparse
import json
import sys

from .core import process_events


def _error(message: str) -> None:
    print(f"sessionize: error: {message}", file=sys.stderr)


def _parse_event(raw: str, lineno: int) -> dict:
    try:
        record = json.loads(raw)
    except json.JSONDecodeError as exc:
        _error(f"line {lineno}: invalid JSON: {exc}")
        raise SystemExit(2)
    if not isinstance(record, dict):
        _error(f"line {lineno}: event must be a JSON object")
        raise SystemExit(2)
    for field in ("key", "ts", "id"):
        if field not in record:
            _error(f"line {lineno}: missing required field {field!r}")
            raise SystemExit(2)
    ts = record["ts"]
    if isinstance(ts, bool) or not isinstance(ts, int):
        _error(f"line {lineno}: 'ts' must be an integer")
        raise SystemExit(2)
    return {"key": str(record["key"]), "ts": ts, "id": str(record["id"])}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m sessionize",
        description="Sessionize JSONL events per key over event time.",
    )
    parser.add_argument("--in", dest="input", required=True, help="input JSONL file")
    parser.add_argument("--gap", type=int, required=True, help="session gap (ms)")
    parser.add_argument("--late", type=int, required=True, help="allowed lateness (ms)")
    parser.add_argument("--out", dest="output", default=None, help="output file (default: stdout)")
    args = parser.parse_args(argv)

    if args.gap < 0 or args.late < 0:
        _error("--gap and --late must be non-negative")
        return 2

    events = []
    try:
        with open(args.input, "r", encoding="utf-8") as handle:
            for lineno, line in enumerate(handle, start=1):
                line = line.strip()
                if line:
                    events.append(_parse_event(line, lineno))
    except OSError as exc:
        _error(str(exc))
        return 1

    records = process_events(events, args.gap, args.late)

    out_handle = sys.stdout
    try:
        if args.output:
            out_handle = open(args.output, "w", encoding="utf-8")
        for record in records:
            out_handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError as exc:
        _error(str(exc))
        return 1
    finally:
        if out_handle is not sys.stdout:
            out_handle.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
