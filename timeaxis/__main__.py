"""JSON CLI for the timeaxis library.

Every command reads/writes JSON so results are machine-verifiable.

Examples:
  python3.11 -m timeaxis validate table.json
  python3.11 -m timeaxis evidence table.json
  python3.11 -m timeaxis to-instant table.json "2024-03-31T01:30:00"
  python3.11 -m timeaxis to-local table.json "2024-03-31T00:30:00Z"
  python3.11 -m timeaxis interval table.json START END [--start-bound open] [--end-bound closed]
  python3.11 -m timeaxis add-days "2024-01-31T10:00:00" 1
  python3.11 -m timeaxis add-months "2024-01-31T10:00:00" 1
  python3.11 -m timeaxis add-seconds "2024-03-31T00:00:00Z" 86400
  python3.11 -m timeaxis enumerate table.json FROM_UTC TO_UTC
"""
from __future__ import annotations

import argparse
import json
import sys

from .core import (
    Duration,
    Instant,
    LocalDateTime,
    TableError,
    TransitionTable,
    format_offset,
)


def _load_table(path: str) -> TransitionTable:
    with open(path, "r", encoding="utf-8") as fh:
        return TransitionTable.from_json(fh.read())


def _candidate_dict(candidate) -> dict:
    return {
        "instant": candidate.instant.to_iso(),
        "epoch_seconds": candidate.instant.epoch_seconds,
        "segment_index": candidate.segment.index,
        "offset": format_offset(candidate.segment.offset),
    }


def _emit(payload) -> int:
    print(json.dumps(payload, indent=2))
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="timeaxis")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("validate", help="validate a transition table")
    p.add_argument("table")

    p = sub.add_parser("evidence", help="dump segmented mapping evidence")
    p.add_argument("table")

    p = sub.add_parser("to-instant", help="local wall clock -> 0/1/2 instants")
    p.add_argument("table")
    p.add_argument("local")

    p = sub.add_parser("to-local", help="UTC instant -> local wall clock")
    p.add_argument("table")
    p.add_argument("instant")

    p = sub.add_parser("interval", help="local interval -> union of UTC intervals")
    p.add_argument("table")
    p.add_argument("start")
    p.add_argument("end")
    p.add_argument("--start-bound", choices=["closed", "open"], default="closed")
    p.add_argument("--end-bound", choices=["closed", "open"], default="open")

    p = sub.add_parser("add-days", help="wall-clock arithmetic: add calendar days")
    p.add_argument("local")
    p.add_argument("days", type=int)

    p = sub.add_parser("add-months", help="wall-clock arithmetic: add calendar months")
    p.add_argument("local")
    p.add_argument("months", type=int)

    p = sub.add_parser("add-seconds", help="timeline arithmetic: add elapsed seconds")
    p.add_argument("instant")
    p.add_argument("seconds", type=int)

    p = sub.add_parser("enumerate", help="per-second UTC->local mapping evidence")
    p.add_argument("table")
    p.add_argument("from_instant")
    p.add_argument("to_instant")

    args = parser.parse_args(argv)

    try:
        if args.command == "validate":
            table = _load_table(args.table)
            return _emit({"valid": True, "segments": len(table.segments)})
        if args.command == "evidence":
            return _emit({"segments": _load_table(args.table).evidence()})
        if args.command == "to-instant":
            table = _load_table(args.table)
            local = LocalDateTime.from_iso(args.local)
            candidates = table.local_to_instant(local)
            return _emit({
                "local": local.to_iso(),
                "count": len(candidates),
                "candidates": [_candidate_dict(c) for c in candidates],
            })
        if args.command == "to-local":
            table = _load_table(args.table)
            instant = Instant.from_iso(args.instant)
            return _emit({
                "instant": instant.to_iso(),
                "local": table.instant_to_local(instant).to_iso(),
            })
        if args.command == "interval":
            table = _load_table(args.table)
            pieces = table.local_interval_to_utc(
                LocalDateTime.from_iso(args.start),
                LocalDateTime.from_iso(args.end),
                start_closed=args.start_bound == "closed",
                end_closed=args.end_bound == "closed",
            )
            return _emit({
                "count": len(pieces),
                "utc_intervals": [piece.to_dict() for piece in pieces],
            })
        if args.command == "add-days":
            local = LocalDateTime.from_iso(args.local)
            return _emit({
                "kind": "wall_clock",
                "result": local.add_days(args.days).to_iso(),
            })
        if args.command == "add-months":
            local = LocalDateTime.from_iso(args.local)
            return _emit({
                "kind": "wall_clock",
                "result": local.add_months(args.months).to_iso(),
            })
        if args.command == "add-seconds":
            instant = Instant.from_iso(args.instant)
            result = instant + Duration.from_seconds(args.seconds)
            return _emit({"kind": "timeline", "result": result.to_iso()})
        if args.command == "enumerate":
            table = _load_table(args.table)
            start = Instant.from_iso(args.from_instant).epoch_seconds
            end = Instant.from_iso(args.to_instant).epoch_seconds
            rows = []
            for epoch in range(start, end):
                local = table.instant_to_local(Instant(epoch))
                seg = table.segment_at(Instant(epoch))
                rows.append({
                    "utc": Instant(epoch).to_iso(),
                    "local": local.to_iso(),
                    "segment_index": seg.index,
                })
            return _emit({"rows": rows})
    except (TableError, ValueError, KeyError) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
