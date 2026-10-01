"""Input parsing and validation for latefix."""

from __future__ import annotations

import json
import math

from .core import Event


class InputError(Exception):
    """Raised for malformed input lines (CLI exits with code 2)."""


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def parse_line(line: str, lineno: int = 0) -> Event:
    try:
        obj = json.loads(line)
    except json.JSONDecodeError as exc:
        raise InputError(f"line {lineno}: invalid JSON: {exc}") from exc
    if not isinstance(obj, dict):
        raise InputError(f"line {lineno}: expected a JSON object")
    for field in ("key", "ts", "val"):
        if field not in obj:
            raise InputError(f"line {lineno}: missing field {field!r}")
    key = obj["key"]
    if not isinstance(key, str):
        raise InputError(f"line {lineno}: 'key' must be a string")
    ts = obj["ts"]
    if not _is_number(ts):
        raise InputError(f"line {lineno}: 'ts' must be a number")
    if isinstance(ts, float):
        if not (math.isfinite(ts) and ts.is_integer()):
            raise InputError(f"line {lineno}: 'ts' must be an integer")
        ts = int(ts)
    val = obj["val"]
    if not _is_number(val) or (isinstance(val, float) and not math.isfinite(val)):
        raise InputError(f"line {lineno}: 'val' must be a number")
    return Event(key=key, ts=ts, val=val)
