"""JSON command-line interface.

Usage:
    python3.11 -m billcycle expand --rule rule.json \
        --start 2024-01-01T00:00:00Z --end 2026-01-01T00:00:00Z \
        [--holidays holidays.json] [--page-size N] [--cursor C] [--reverse]
    python3.11 -m billcycle verify --rule rule.json \
        --start-date 2023-01-01 --end-date 2027-01-01 [--holidays H]

All input/output is JSON on stdin/stdout; results are deterministic.
Exit codes: 0 ok, 2 rule/cursor/input error.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime, timezone

from . import engine, reference, tztable
from .calendar import BusinessCalendar
from .rule import Rule


def _load_json(path: str):
    try:
        text = sys.stdin.read() if path == "-" else open(path).read()
    except OSError as exc:
        raise ValueError(f"cannot read {path}: {exc}") from None
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON in {path}: {exc}") from None


def _load_rule(path: str) -> Rule:
    return Rule.from_json(_load_json(path))


def _load_calendar(path: str | None) -> BusinessCalendar:
    if path is None:
        return BusinessCalendar()
    data = _load_json(path)
    raw = data.get("holidays", {})
    if isinstance(raw, dict):
        holidays = {date.fromisoformat(k): str(v) for k, v in raw.items()}
    else:
        holidays = {date.fromisoformat(s): "" for s in raw}
    weekend = tuple(data.get("weekend", (5, 6)))
    return BusinessCalendar(holidays=holidays, weekend=weekend)


def _parse_utc(text: str) -> int:
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        raise ValueError(f"invalid UTC timestamp: {text!r}") from None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def _emit(payload: dict) -> None:
    json.dump(payload, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


def _cmd_expand(args) -> int:
    rule = _load_rule(args.rule)
    cal = _load_calendar(args.holidays)
    zone = tztable.get_zone(rule.zone)
    start_utc = _parse_utc(args.start)
    end_utc = _parse_utc(args.end)
    page = engine.paginate(rule, cal, zone, start_utc, end_utc,
                           page_size=args.page_size, cursor=args.cursor,
                           reverse=args.reverse)
    _emit({
        "rule_version": rule.version,
        "exception_hash": rule.exception_hash(),
        "zone": zone.name,
        "direction": page.direction,
        "has_more": page.has_more,
        "next_cursor": page.next_cursor,
        "occurrences": [o.to_json(zone) for o in page.occurrences],
        "rejected": page.rejected,
        "removed": page.removed,
    })
    return 0


def _cmd_verify(args) -> int:
    rule = _load_rule(args.rule)
    cal = _load_calendar(args.holidays)
    zone = tztable.get_zone(rule.zone)
    start = date.fromisoformat(args.start_date)
    end = date.fromisoformat(args.end_date)
    report = reference.cross_check(rule, cal, zone, start, end)
    report["rule_version"] = rule.version
    _emit(report)
    return 0 if report["ok"] else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="billcycle")
    sub = parser.add_subparsers(dest="command", required=True)

    exp = sub.add_parser("expand", help="expand a rule over a UTC range")
    exp.add_argument("--rule", required=True, help="rule JSON file, or -")
    exp.add_argument("--holidays", help="calendar JSON file")
    exp.add_argument("--start", required=True, help="range start, UTC ISO")
    exp.add_argument("--end", required=True, help="range end (excl), UTC ISO")
    exp.add_argument("--page-size", type=int, default=50)
    exp.add_argument("--cursor", help="pagination cursor from a prior page")
    exp.add_argument("--reverse", action="store_true",
                     help="paginate backwards (descending UTC)")
    exp.set_defaults(func=_cmd_expand)

    ver = sub.add_parser("verify",
                         help="cross-check engine vs reference enumerator")
    ver.add_argument("--rule", required=True)
    ver.add_argument("--holidays")
    ver.add_argument("--start-date", required=True)
    ver.add_argument("--end-date", required=True)
    ver.set_defaults(func=_cmd_verify)
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (ValueError, engine.CursorMismatch) as exc:
        _emit({"error": type(exc).__name__, "message": str(exc)})
        return 2


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
