"""Core dedup-window processor.

Semantics
---------
* ``skew`` is the global upper bound on the max-ts difference across sources.
* ``ret`` is the retention horizon.
* The processing lower bound is ``L = max_ts - skew - ret`` where ``max_ts``
  is the maximum event ts observed so far.  Events with ``ts < L`` are too
  late and are dropped.
* The first record seen for an id (among records that pass the lower bound)
  takes effect; later records with the same id are duplicates.  If a
  duplicate's fields differ from the first record, the first record still
  wins and a conflict is recorded.
* Per-id state is evicted only when the id's max observed ts falls strictly
  below ``L - ret``; an id whose max ts is exactly ``L - ret`` is retained,
  so ids that may still deduplicate future events are never evicted early.
"""

_MISSING = object()


class MissingFieldError(ValueError):
    """Raised when a record lacks the required ``id`` or ``ts`` field."""


class DedupWin:
    def __init__(self, skew, ret):
        if skew < 0 or ret < 0:
            raise ValueError("skew and ret must be non-negative")
        self.skew = skew
        self.ret = ret
        self.max_ts = None
        # id -> [max_ts_for_id, first_record]
        self._state = {}
        self._emitted = []
        self.duplicates = 0
        self.conflicts = 0
        self.bad = 0
        self.dropped_late = 0
        self.evicted = 0

    @property
    def lower_bound(self):
        """Current processing lower bound L, or None before any event."""
        if self.max_ts is None:
            return None
        return self.max_ts - self.skew - self.ret

    def _evict(self):
        threshold = self.lower_bound - self.ret
        stale = [rid for rid, ent in self._state.items() if ent[0] < threshold]
        for rid in stale:
            del self._state[rid]
            self.evicted += 1

    def add(self, rec):
        """Feed one validated record (dict with ``id`` and ``ts``)."""
        if "id" not in rec or "ts" not in rec:
            raise MissingFieldError("record missing required 'id' or 'ts'")
        ts = rec["ts"]
        rid = rec["id"]
        if self.max_ts is None or ts > self.max_ts:
            self.max_ts = ts
        self._evict()
        if ts < self.lower_bound:
            self.dropped_late += 1
            return
        ent = self._state.get(rid)
        if ent is None:
            self._state[rid] = [ts, rec]
            self._emitted.append(rec)
            return
        if ts > ent[0]:
            ent[0] = ts
        self.duplicates += 1
        first = ent[1]
        for field in ("key", "ts", "val"):
            if rec.get(field, _MISSING) != first.get(field, _MISSING):
                self.conflicts += 1
                break

    def results(self):
        """Emitted records sorted by (ts, id); stable for equal keys."""
        return sorted(self._emitted, key=lambda r: (r["ts"], r["id"]))

    def stats(self):
        return {
            "emitted": len(self._emitted),
            "duplicates": self.duplicates,
            "conflicts": self.conflicts,
            "bad": self.bad,
            "dropped_late": self.dropped_late,
            "evicted": self.evicted,
            "live_ids": len(self._state),
        }
