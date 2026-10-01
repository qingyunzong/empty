"""Canonical atomic decomposition of collinear overlapping segments.

Input segments are grouped by supporting line; within each line a 1D
sweep produces elementary (atomic) intervals, each annotated with the
set of source segment ids covering it.  Zero-length "point" segments
are returned separately.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .geom import line_key, param_t


@dataclass
class AtomicSeg:
    """A maximal segment on one supporting line with constant sources."""

    p: tuple  # endpoint with smaller parameter
    q: tuple  # endpoint with larger parameter
    sources: frozenset  # ids of original segments covering p-q
    line: tuple  # canonical supporting-line key


@dataclass
class AtomicResult:
    segments: list = field(default_factory=list)  # list[AtomicSeg]
    points: list = field(default_factory=list)    # list[(point, source_id)]


def atomic_decomposition(segments):
    """Decompose ``{sid: (p, q)}`` into atomic segments + point segments.

    ``p``/``q`` are exact points.  Overlapping collinear runs are merged
    into canonical atoms carrying the frozenset of covering source ids.
    """
    lines = {}   # line key -> list of (t_lo, t_hi, p_lo, p_hi, sid)
    points = []  # (point, sid)
    for sid, (p, q) in segments.items():
        if p == q:
            points.append((p, sid))
            continue
        key = line_key(p, q)
        tp, tq = param_t(key, p), param_t(key, q)
        if tp <= tq:
            lines.setdefault(key, []).append((tp, tq, p, q, sid))
        else:
            lines.setdefault(key, []).append((tq, tp, q, p, sid))

    result = AtomicResult(points=points)
    for key, segs in lines.items():
        # 1D sweep over interval endpoints.
        events = []  # (t, kind, sid, point)  kind: 0=open 1=close
        for t_lo, t_hi, p_lo, p_hi, sid in segs:
            events.append((t_lo, 0, sid, p_lo))
            events.append((t_hi, 1, sid, p_hi))
        events.sort(key=lambda e: (e[0], e[1]))
        active = set()
        cur_t = None
        cur_p = None
        idx = 0
        # Process events grouped by parameter value.
        groups = {}
        for t, kind, sid, pt in events:
            groups.setdefault(t, []).append((kind, sid, pt))
        for t in sorted(groups):
            # Representative point on the line at parameter t.
            pt = groups[t][0][2]
            if active and cur_t is not None and cur_t < t:
                result.segments.append(
                    AtomicSeg(cur_p, pt, frozenset(active), key)
                )
            for kind, sid, _ in groups[t]:
                if kind == 0:
                    active.add(sid)
                else:
                    active.discard(sid)
            cur_t, cur_p = t, pt
    return result
