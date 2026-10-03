"""Band join over two event streams with per-side watermarks.

Semantics
---------
* Each side has an independent watermark: ``WM = max_ts_seen - skew``.
  A watermark W means "no future event on this side will have ts < W".
* An arriving event (either side) is *late* -- and is dropped and counted --
  when ``ts < max(left_wm, right_wm) - bound``.  Its join window can no
  longer intersect any event that could still arrive or is still retained.
* Duplicate ids on the same side are the same logical event: the first
  occurrence wins, later ones are ignored and counted as duplicates.
* A pair (l, r) matches when ``l.key == r.key`` and
  ``abs(l.ts - r.ts) <= bound`` (inclusive, so ``bound=0`` requires equal ts).
* The match safe point is ``min(left_wm, right_wm) + bound``: a retained
  event is evicted from state only when ``ts + bound < other_side_wm``,
  i.e. no future event on the other side could still match it.  Events are
  never treated as unsatisfiable just because the other side has not
  caught up yet; they are simply kept until the watermarks prove otherwise.
* ``finalize()`` returns every pair found, sorted deterministically by
  ``(key, l.ts, r.ts, l_id, r_id)``.
"""

from __future__ import annotations

NEG_INF = float("-inf")


def _sort_token(value):
    """Type-stable sort token so mixed int/str ids never raise."""
    if isinstance(value, bool):
        return (2, str(value))
    if isinstance(value, (int, float)):
        return (0, value)
    if isinstance(value, str):
        return (1, value)
    return (2, str(value))


class BandJoin:
    """Streaming band join with watermarks, lateness dropping and dedup."""

    def __init__(self, bound, left_skew=0, right_skew=0):
        if bound < 0:
            raise ValueError("bound must be >= 0")
        if left_skew < 0 or right_skew < 0:
            raise ValueError("skews must be >= 0")
        self.bound = bound
        self.left_skew = left_skew
        self.right_skew = right_skew
        self._left = {}    # live left state:  id -> (key, ts)
        self._right = {}   # live right state: id -> (key, ts)
        self._seen_left = set()
        self._seen_right = set()
        self._max_left = None
        self._max_right = None
        self._pairs = {}   # (l_id, r_id) -> (l_id, r_id, key, ts_l, ts_r)
        self.stats = {
            "left_total": 0,
            "right_total": 0,
            "left_dup": 0,
            "right_dup": 0,
            "left_late": 0,
            "right_late": 0,
        }

    @property
    def left_wm(self):
        if self._max_left is None:
            return NEG_INF
        return self._max_left - self.left_skew

    @property
    def right_wm(self):
        if self._max_right is None:
            return NEG_INF
        return self._max_right - self.right_skew

    @property
    def safe_point(self):
        """min(LWM, RWM) + bound: pairs at/below it can never grow."""
        return min(self.left_wm, self.right_wm) + self.bound

    def _lateness_threshold(self):
        return max(self.left_wm, self.right_wm) - self.bound

    def add_left(self, ident, key, ts):
        self.stats["left_total"] += 1
        if ident in self._seen_left:
            self.stats["left_dup"] += 1
            return
        self._seen_left.add(ident)
        self._max_left = ts if self._max_left is None else max(self._max_left, ts)
        if ts < self._lateness_threshold():
            self.stats["left_late"] += 1
            return
        self._left[ident] = (key, ts)
        for r_id, (r_key, r_ts) in self._right.items():
            if r_key == key and abs(ts - r_ts) <= self.bound:
                self._record(ident, key, ts, r_id, r_ts)
        self._evict()

    def add_right(self, ident, key, ts):
        self.stats["right_total"] += 1
        if ident in self._seen_right:
            self.stats["right_dup"] += 1
            return
        self._seen_right.add(ident)
        self._max_right = ts if self._max_right is None else max(self._max_right, ts)
        if ts < self._lateness_threshold():
            self.stats["right_late"] += 1
            return
        self._right[ident] = (key, ts)
        for l_id, (l_key, l_ts) in self._left.items():
            if l_key == key and abs(l_ts - ts) <= self.bound:
                self._record(l_id, l_key, l_ts, ident, ts)
        self._evict()

    def _record(self, l_id, key, ts_l, r_id, ts_r):
        self._pairs[(l_id, r_id)] = (l_id, r_id, key, ts_l, ts_r)

    def _evict(self):
        rwm = self.right_wm
        if rwm != NEG_INF:
            self._left = {
                i: e for i, e in self._left.items() if e[1] + self.bound >= rwm
            }
        lwm = self.left_wm
        if lwm != NEG_INF:
            self._right = {
                i: e for i, e in self._right.items() if e[1] + self.bound >= lwm
            }

    def finalize(self):
        """Return all matched pairs, sorted by (key, ts_l, ts_r, l_id, r_id)."""
        ordered = sorted(
            self._pairs.values(),
            key=lambda p: (
                _sort_token(p[2]),
                _sort_token(p[3]),
                _sort_token(p[4]),
                _sort_token(p[0]),
                _sort_token(p[1]),
            ),
        )
        return [
            {"l_id": l_id, "r_id": r_id, "key": key, "ts_l": ts_l, "ts_r": ts_r}
            for (l_id, r_id, key, ts_l, ts_r) in ordered
        ]
