"""Shared fixtures and the independent brute-force oracle for the tests."""
from __future__ import annotations

from datetime import datetime, timezone

from timeline import OffsetTable, Segment


def U(year, month, day, hour=0, minute=0, second=0) -> int:
    """UTC epoch seconds."""
    return int(datetime(year, month, day, hour, minute, second,
                        tzinfo=timezone.utc).timestamp())


def L(year, month, day, hour=0, minute=0, second=0) -> int:
    """Naive wall-clock seconds on the local axis."""
    base = datetime(1970, 1, 1)
    dt = datetime(year, month, day, hour, minute, second)
    delta = dt - base
    return delta.days * 86400 + delta.seconds


def dst_table() -> OffsetTable:
    """Whole-hour table: spring-forward gap + autumn-backward fold."""
    a = U(2024, 3, 31, 1)    # 01:00Z: offset 0 -> +3600 (gap 01:00-02:00 local)
    b = U(2024, 10, 27, 1)   # 01:00Z: offset +3600 -> 0 (fold 01:00-02:00 local)
    return OffsetTable([
        Segment("winter-before", None, a, 0),
        Segment("summer", a, b, 3600),
        Segment("winter-after", b, None, 0),
    ])


def historical_table() -> OffsetTable:
    """Non-whole-hour historical offsets, consecutive changes, cross-midnight.

    * lmt:    +08:05:43 (29143 s) local-mean-time style offset
    * first:  +05:30    (19800 s) from 2024-01-01T00:00:00Z
    * second: +05:45    (20700 s) from 2024-06-30T18:30:00Z  (local midnight!)
    * third:  +06:30    (23400 s) from 2024-06-30T19:00:00Z  (30 min later)
    """
    t1 = U(2024, 1, 1, 0, 0, 0)
    t2 = U(2024, 6, 30, 18, 30, 0)
    t3 = U(2024, 6, 30, 19, 0, 0)
    return OffsetTable([
        Segment("lmt", None, t1, 29143),
        Segment("plus530", t1, t2, 19800),
        Segment("plus545", t2, t3, 20700),
        Segment("plus630", t3, None, 23400),
    ])


def brute_candidates(segments, local_seconds: int) -> list[int]:
    """Independent oracle: scan every segment directly."""
    out = []
    for seg in segments:
        instant = local_seconds - seg.offset_seconds
        if seg.contains_utc(instant):
            out.append(instant)
    return sorted(out)


def brute_local_map(segments, utc_lo: int, utc_hi: int) -> dict[int, list[int]]:
    """Independent oracle built the other way around: walk every UTC second
    in [utc_lo, utc_hi), find its segment by linear scan, and record which
    wall-clock second it maps to."""
    mapping: dict[int, list[int]] = {}
    for instant in range(utc_lo, utc_hi):
        for seg in segments:
            if seg.contains_utc(instant):
                local = instant + seg.offset_seconds
                mapping.setdefault(local, []).append(instant)
                break
    return mapping
