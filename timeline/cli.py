"""JSON command-line interface.

Usage:  python3.11 -m timeline [request.json]   (defaults to stdin)

The request is a JSON object with a ``command`` field.  Instants are ISO
strings with an explicit ``Z`` (or epoch integers); wall-clock times are
naive ISO strings.  A table is ``{"segments": [{"id", "utc_start",
"utc_end", "offset_seconds"}...]}`` where utc_start/utc_end are ISO-Z
strings, epoch integers, or null for an open end.

Commands:
  local_to_instant   {table, local}                 -> candidates + evidence
  instant_to_local   {table, instant}               -> wall clock + segment
  convert_interval   {table, interval}              -> utc pieces + gaps
  add_days           {local, days}                  -> wall clock
  add_months         {local, months}                -> wall clock
  add_seconds        {instant, seconds}             -> instant
  validate_table     {table}                        -> ok / error
  revise             {table, revision:[segments]}   -> new table, atomic
"""
from __future__ import annotations

import json
import sys

from .arithmetic import (add_days_wallclock, add_months_wallclock,
                         add_seconds_timeline)
from .core import Instant, LocalDateTime
from .intervals import LocalInterval, convert_interval
from .mapping import instant_to_local, local_to_instant
from .table import OffsetTable, Segment


def _instant(value) -> int:
    if isinstance(value, (int, float)):
        return int(value)
    return Instant.from_iso(str(value)).epoch_seconds


def _instant_or_none(value):
    if value is None:
        return None
    return _instant(value)


def _local(value) -> int:
    if isinstance(value, (int, float)):
        return int(value)
    return LocalDateTime.from_iso(str(value)).local_seconds()


def _table(obj) -> OffsetTable:
    segs = []
    for s in obj["segments"]:
        segs.append(Segment(
            seg_id=str(s["id"]),
            utc_start=_instant_or_none(s.get("utc_start")),
            utc_end=_instant_or_none(s.get("utc_end")),
            offset_seconds=int(s["offset_seconds"]),
        ))
    return OffsetTable(segs, version=int(obj.get("version", 1)))


def _table_json(table: OffsetTable) -> dict:
    return {
        "version": table.version,
        "segments": [{
            "id": s.seg_id,
            "utc_start": None if s.utc_start is None else Instant(s.utc_start).to_iso(),
            "utc_end": None if s.utc_end is None else Instant(s.utc_end).to_iso(),
            "offset_seconds": s.offset_seconds,
        } for s in table.segments],
    }


def handle(request: dict) -> dict:
    command = request["command"]
    if command == "local_to_instant":
        table = _table(request["table"])
        local = _local(request["local"])
        cands = local_to_instant(table, local)
        return {"count": len(cands), "candidates": [{
            "instant": Instant(c.instant).to_iso(),
            "epoch_seconds": c.instant,
            "evidence": c.evidence(),
        } for c in cands]}
    if command == "instant_to_local":
        table = _table(request["table"])
        local, seg = instant_to_local(table, _instant(request["instant"]))
        return {"local": LocalDateTime.from_local_seconds(local).to_iso(),
                "local_seconds": local, "segment_id": seg.seg_id,
                "offset_seconds": seg.offset_seconds}
    if command == "convert_interval":
        table = _table(request["table"])
        spec = request["interval"]
        interval = LocalInterval(
            start=_local(spec["start"]), end=_local(spec["end"]),
            start_closed=bool(spec.get("start_closed", True)),
            end_closed=bool(spec.get("end_closed", False)))
        result = convert_interval(table.segments, interval)
        return {
            "pieces": [p.evidence() for p in result.pieces],
            "gaps": [[g.start, g.end] for g in result.gaps],
        }
    if command == "add_days":
        out = add_days_wallclock(LocalDateTime.from_iso(request["local"]),
                                 int(request["days"]))
        return {"local": out.to_iso()}
    if command == "add_months":
        out = add_months_wallclock(LocalDateTime.from_iso(request["local"]),
                                   int(request["months"]))
        return {"local": out.to_iso()}
    if command == "add_seconds":
        out = add_seconds_timeline(Instant.from_iso(request["instant"]),
                                   int(request["seconds"]))
        return {"instant": out.to_iso(), "epoch_seconds": out.epoch_seconds}
    if command == "validate_table":
        _table(request["table"])
        return {"ok": True}
    if command == "revise":
        table = _table(request["table"])
        revision = [Segment(
            seg_id=str(s["id"]),
            utc_start=_instant_or_none(s.get("utc_start")),
            utc_end=_instant_or_none(s.get("utc_end")),
            offset_seconds=int(s["offset_seconds"]),
        ) for s in request["revision"]]
        table.revise(revision)
        return {"applied": True, "table": _table_json(table)}
    raise ValueError(f"unknown command {command!r}")


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    raw = open(argv[0]).read() if argv else sys.stdin.read()
    try:
        response = handle(json.loads(raw))
    except Exception as exc:  # atomic rejections surface as errors
        json.dump({"ok": False, "error": f"{type(exc).__name__}: {exc}"},
                  sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 1
    json.dump(response, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
