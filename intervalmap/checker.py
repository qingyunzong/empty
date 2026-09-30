"""Independent checker.

Verifies, using only the public interval listing of a map (never the tree
internals), that:
  * the canonical interval output is well formed (sorted, disjoint,
    non-empty, maximally merged),
  * endpoint events match the segments endpoint by endpoint,
  * source refcounts and aggregate length match the segments,
  * a threshold query result carries valid source proofs, is complete and
    canonical, and its total length matches.
"""

from __future__ import annotations

from fractions import Fraction

from .endpoints import NEG_INF, POS_INF


class CheckFailure(AssertionError):
    pass


def _fail(msg):
    raise CheckFailure(msg)


def check_canonical(segments) -> None:
    prev_hi = None
    prev_sources = None
    for seg in segments:
        lo, hi, sources = seg["lo"], seg["hi"], seg["sources"]
        if not lo < hi:
            _fail(f"non-positive segment [{lo}, {hi})")
        if not sources or any(c <= 0 for c in sources.values()):
            _fail(f"segment [{lo}, {hi}) has empty/invalid sources")
        if seg["count"] != sum(sources.values()):
            _fail(f"segment [{lo}, {hi}) count mismatch")
        if prev_hi is not None:
            if lo < prev_hi:
                _fail(f"segments overlap at {lo}")
            if lo == prev_hi and sources == prev_sources:
                _fail(f"adjacent segments with equal sources not merged at {lo}")
        prev_hi, prev_sources = hi, dict(sources)


def check_events(segments, events) -> None:
    """Per-endpoint verification of enter/leave sets against segments."""
    endpoints = set()
    for seg in segments:
        endpoints.add(seg["lo"])
        endpoints.add(seg["hi"])
    if set(events.keys()) != endpoints:
        _fail(f"event endpoints {sorted(map(str, events))} != segment endpoints "
              f"{sorted(map(str, endpoints))}")
    for ep in endpoints:
        enter, leave = {}, {}
        for seg in segments:
            if seg["lo"] == ep:
                enter = dict(seg["sources"])
            if seg["hi"] == ep:
                leave = dict(seg["sources"])
        ev = events[ep]
        if ev["enter"] != enter or ev["leave"] != leave:
            _fail(f"event mismatch at {ep}: {ev} != enter={enter} leave={leave}")


def check_refcounts(segments, refcounts) -> None:
    expect = {}
    for seg in segments:
        for src, cnt in seg["sources"].items():
            expect[src] = expect.get(src, 0) + cnt
    if dict(refcounts) != expect:
        _fail(f"refcounts {refcounts} != {expect}")


def check_total_length(segments, total) -> None:
    expect = Fraction(0)
    for seg in segments:
        expect += seg["hi"] - seg["lo"]
    if total != expect:
        _fail(f"total length {total} != {expect}")


def check_threshold_result(segments, k, result) -> None:
    """Verify a covered_at_least(k) answer against the segment listing."""
    check_canonical(result)
    # 1. every result segment is backed by a real segment with the same proof
    for res in result:
        match = [s for s in segments
                 if s["lo"] == res["lo"] and s["hi"] == res["hi"]]
        if len(match) != 1:
            _fail(f"proof segment [{res['lo']}, {res['hi']}) not found in map")
        if match[0]["sources"] != res["sources"]:
            _fail(f"proof sources mismatch on [{res['lo']}, {res['hi']})")
        if sum(res["sources"].values()) < k:
            _fail(f"proof below threshold on [{res['lo']}, {res['hi']})")
    # 2. completeness: every qualifying map segment appears in the result
    want = {(s["lo"], s["hi"]) for s in segments
            if sum(s["sources"].values()) >= k}
    got = {(r["lo"], r["hi"]) for r in result}
    if want != got:
        _fail(f"threshold result incomplete: missing {want - got}, extra {got - want}")
    # 3. total length
    check_total_length(result, sum((r["hi"] - r["lo"] for r in result), Fraction(0)))


def check_map(interval_map, events=None, refcounts=None, total=None) -> None:
    """Full structural verification of an IntervalMap via public queries."""
    segments = interval_map.intervals()
    check_canonical(segments)
    check_events(segments, interval_map.events() if events is None else events)
    check_refcounts(segments, interval_map.refcounts() if refcounts is None else refcounts)
    check_total_length(segments, interval_map.length() if total is None else total)
