"""JSON command-line interface.

Commands:
  expand   --rule rule.json --start <utc> --end <utc>
           [--limit N] [--cursor C] [--direction forward|backward]
  verify   --rule rule.json --start-year Y --end-year Y
  tables   (list built-in offline tz tables)

All output is JSON on stdout; errors are JSON on stderr with exit code 2.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone

from .engine import StaleCursorError, expand, paginate
from .model import Rule
from .reference import reference_utc_instants
from .tztable import table_names


def _parse_utc(s: str) -> int:
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def _load_rule(path: str) -> Rule:
    with open(path, "r", encoding="utf-8") as fh:
        return Rule.from_dict(json.load(fh))


def _emit(obj: dict, fh=sys.stdout):
    json.dump(obj, fh, indent=2, ensure_ascii=False)
    fh.write("\n")


def _fail(msg: str) -> int:
    json.dump({"error": msg}, sys.stderr, indent=2, ensure_ascii=False)
    sys.stderr.write("\n")
    return 2


def cmd_expand(args) -> int:
    rule = _load_rule(args.rule)
    start, end = _parse_utc(args.start), _parse_utc(args.end)
    if args.limit is None:
        result = expand(rule, start, end)
        _emit(result.to_dict())
    else:
        try:
            page = paginate(rule, start, end, limit=args.limit,
                            cursor=args.cursor, direction=args.direction)
        except StaleCursorError as exc:
            return _fail(str(exc))
        _emit(page.to_dict())
    return 0


def cmd_verify(args) -> int:
    rule = _load_rule(args.rule)
    start = int(datetime(args.start_year, 1, 1, tzinfo=timezone.utc).timestamp())
    end = int(datetime(args.end_year + 1, 1, 1, tzinfo=timezone.utc).timestamp())
    engine = {o.utc_ts for o in expand(rule, start, end).occurrences}
    reference = {ts for ts in reference_utc_instants(rule, args.start_year - 1,
                                                     args.end_year + 1)
                 if start <= ts < end}
    only_engine = sorted(engine - reference)
    only_reference = sorted(reference - engine)
    _emit({
        "match": not only_engine and not only_reference,
        "window": [args.start_year, args.end_year],
        "engine_count": len(engine),
        "reference_count": len(reference),
        "only_in_engine": [datetime.fromtimestamp(t, timezone.utc).isoformat()
                           for t in only_engine],
        "only_in_reference": [datetime.fromtimestamp(t, timezone.utc).isoformat()
                              for t in only_reference],
    })
    return 0 if not only_engine and not only_reference else 1


def cmd_tables(_args) -> int:
    _emit({"tables": table_names()})
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="billcal", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("expand", help="expand a rule into UTC occurrences")
    p.add_argument("--rule", required=True)
    p.add_argument("--start", required=True, help="UTC ISO instant, inclusive")
    p.add_argument("--end", required=True, help="UTC ISO instant, exclusive")
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--cursor", default=None)
    p.add_argument("--direction", default="forward",
                   choices=("forward", "backward"))
    p.set_defaults(func=cmd_expand)

    p = sub.add_parser("verify", help="cross-check engine vs reference")
    p.add_argument("--rule", required=True)
    p.add_argument("--start-year", type=int, required=True)
    p.add_argument("--end-year", type=int, required=True)
    p.set_defaults(func=cmd_verify)

    p = sub.add_parser("tables", help="list built-in offline tz tables")
    p.set_defaults(func=cmd_tables)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (StaleCursorError,) as exc:
        return _fail(str(exc))
    except (ValueError, KeyError, FileNotFoundError) as exc:
        return _fail(str(exc))


if __name__ == "__main__":
    raise SystemExit(main())
