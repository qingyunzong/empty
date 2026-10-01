"""Exact Bentley-Ottmann sweep-line intersection for atomic segments.

The sweep maintains an active ordered status (ordered bottom-to-top just
right of the current sweep position) and a priority queue of event
points.  Events at the same point are processed as one group: segments
ending or passing through are removed, continuing and starting segments
are re-inserted in post-event order (exact slope tie-break), and only
neighbouring pairs are tested for new intersections -- this is a genuine
sweep, not a pairwise loop.  Vertical segments are handled with a range
query over the status when the sweep reaches their x coordinate.

Input atomic segments never overlap collinearly (guaranteed by
``atomic.atomic_decomposition``), so every intersection is a point.
All arithmetic is exact (Fraction); no floating point anywhere.
"""

from __future__ import annotations

import heapq

from .geom import proper_intersection


class SweepSeg:
    __slots__ = ("p", "q", "idx", "slope", "vertical")

    def __init__(self, p, q, idx):
        # Canonical orientation: p < q in (x, y) lexicographic order.
        if q < p:
            p, q = q, p
        self.p = p
        self.q = q
        self.idx = idx
        self.vertical = p[0] == q[0]
        if self.vertical:
            self.slope = None
        else:
            self.slope = (q[1] - p[1]) / (q[0] - p[0])

    def y_at(self, x):
        """Exact y of the segment at abscissa x (x within [p.x, q.x])."""
        return self.p[1] + (x - self.p[0]) * self.slope

    def contains(self, pt):
        if pt[0] < self.p[0] or pt[0] > self.q[0]:
            return False
        return self.y_at(pt[0]) == pt[1]


def sweep_intersections(atomic_segments):
    """Find every point where two or more atomic segments meet.

    ``atomic_segments`` is a list of objects with ``.p`` and ``.q``
    endpoints.  Returns a sorted list of exact points.  Shared
    endpoints, T-junctions and multi-segment crossings are all reported.
    """
    segs = [SweepSeg(a.p, a.q, i) for i, a in enumerate(atomic_segments)]
    by_idx = {s.idx: s for s in segs}

    events = []  # heap of (x, y, seq, kind, idx)
    seq = 0
    for s in segs:
        if s.vertical:
            heapq.heappush(events, (s.p[0], s.p[1], seq, "V", s.idx))
            seq += 1
        else:
            heapq.heappush(events, (s.p[0], s.p[1], seq, "L", s.idx))
            seq += 1
            heapq.heappush(events, (s.q[0], s.q[1], seq, "R", s.idx))
            seq += 1

    status = []   # ordered list of non-vertical SweepSeg
    found = set()
    queued = set()

    def queue_intersection(pt, cur):
        if pt <= cur or pt in queued:
            return
        queued.add(pt)
        nonlocal seq
        heapq.heappush(events, (pt[0], pt[1], seq, "I", -1))
        seq += 1

    while events:
        x, y, _, _, _ = events[0]
        cur = (x, y)
        # Gather the whole event group at this point.
        starts, ends, verticals = [], [], []
        has_intersection = False
        while events and (events[0][0], events[0][1]) == cur:
            _, _, _, kind, idx = heapq.heappop(events)
            if kind == "L":
                starts.append(by_idx[idx])
            elif kind == "R":
                ends.append(by_idx[idx])
            elif kind == "V":
                verticals.append(by_idx[idx])
            else:
                has_intersection = True

        end_ids = {id(s) for s in ends}
        containing_idx = [i for i, s in enumerate(status) if s.contains(cur)]
        through = [status[i] for i in containing_idx if id(status[i]) not in end_ids]

        # Remove ending + through segments (a contiguous block).
        if containing_idx:
            pos = containing_idx[0]
            del status[containing_idx[0] : containing_idx[-1] + 1]
        else:
            # Pure insertion: no active segment passes through cur, so
            # ordering reduces to comparing y at the current x.
            pos = 0
            while pos < len(status) and status[pos].y_at(x) < cur[1]:
                pos += 1

        # Re-insert continuing + starting segments in post-event order.
        block = sorted(through + starts, key=lambda s: s.slope)
        status[pos:pos] = block

        # New neighbours may intersect ahead of the sweep position.
        def check(i):
            if 0 <= i < len(status) - 1:
                pt = proper_intersection(
                    status[i].p, status[i].q, status[i + 1].p, status[i + 1].q
                )
                if pt is not None:
                    queue_intersection(pt, cur)

        check(pos - 1)
        check(pos + len(block) - 1)

        meeting = {s.idx for s in through + starts + ends}
        if has_intersection or len(meeting) >= 2:
            found.add(cur)

        # Vertical segments: exact range query over the active status.
        for v in verticals:
            y_lo, y_hi = v.p[1], v.q[1]
            for s in status:
                yv = s.y_at(x)
                if y_lo <= yv <= y_hi:
                    found.add((x, yv))
            if meeting and y_lo <= cur[1] <= y_hi:
                found.add(cur)

    return sorted(found)
