"""dedupwin: bounded-skew streaming deduplication over event-time windows.

Semantics
---------
* Global ``skew`` bounds the max event-time (``ts``) difference across sources.
* The processable lower bound is ``L = max_ts - skew - ret``; only records
  with ``ts >= L`` are emittable.
* The first record per ``id`` (in ``(ts, input-order)`` order) wins; later
  duplicates are dropped.  A duplicate whose ``key``/``val`` differ from the
  winner is counted as a conflict; the first record stays authoritative.
* Per-id state may be safely evicted once the id's max observed ``ts`` falls
  strictly below ``L - ret``; ids inside the skew window are never declared
  lost, no matter how long they have been absent.
"""

from __future__ import annotations

from dataclasses import dataclass


class MissingFieldError(ValueError):
    """Raised when a record lacks a required field (``id`` or ``ts``)."""


@dataclass
class _IdState:
    rid: object
    winner: dict
    winner_ts: float
    winner_seq: int
    max_ts: float


class DedupWin:
    """Streaming deduplicator with bounded-skew event-time retention."""

    def __init__(self, skew, ret):
        if skew < 0 or ret < 0:
            raise ValueError("skew and ret must be non-negative")
        self.skew = skew
        self.ret = ret
        self.max_ts = None
        self._state = {}
        self._seq = 0
        self.duplicates = 0
        self.conflicts = 0
        self.bad = 0
        self.evicted = 0

    def lower_bound(self):
        """Current processable lower bound L = max_ts - skew - ret."""
        if self.max_ts is None:
            return None
        return self.max_ts - self.skew - self.ret

    def eviction_bound(self):
        """Ids whose max ts is strictly below this bound may be evicted."""
        bound = self.lower_bound()
        if bound is None:
            return None
        return bound - self.ret

    @staticmethod
    def _fields(record):
        return (record.get("key"), record.get("val"))

    def add(self, record):
        """Feed one record.  Returns True if accepted, False if bad.

        Raises MissingFieldError when ``id`` or ``ts`` is absent/invalid.
        Records with negative ``ts`` are counted as bad and skipped.
        """
        if not isinstance(record, dict):
            raise MissingFieldError("record is not a JSON object")
        rid = record.get("id")
        if rid is None:
            raise MissingFieldError("record missing 'id'")
        ts = record.get("ts")
        if ts is None:
            raise MissingFieldError("record missing 'ts'")
        if isinstance(ts, bool) or not isinstance(ts, (int, float)):
            raise MissingFieldError("record 'ts' is not a number")
        if ts < 0:
            self.bad += 1
            return False

        seq = self._seq
        self._seq += 1
        if self.max_ts is None or ts > self.max_ts:
            self.max_ts = ts

        state = self._state.get(rid)
        if state is None:
            self._state[rid] = _IdState(rid, dict(record), ts, seq, ts)
        else:
            self.duplicates += 1
            if (ts, seq) < (state.winner_ts, state.winner_seq):
                # The new record is earlier in (ts, input-order): it wins and
                # the previous winner becomes a duplicate of it.
                old_winner = state.winner
                state.winner = dict(record)
                state.winner_ts = ts
                state.winner_seq = seq
                if self._fields(old_winner) != self._fields(record):
                    self.conflicts += 1
            elif self._fields(record) != self._fields(state.winner):
                self.conflicts += 1
            if ts > state.max_ts:
                state.max_ts = ts

        self._evict()
        return True

    def _evict(self):
        bound = self.eviction_bound()
        if bound is None:
            return
        doomed = [rid for rid, st in self._state.items() if st.max_ts < bound]
        for rid in doomed:
            del self._state[rid]
            self.evicted += 1

    def results(self):
        """Winning records with ts >= L, sorted by (ts, id) ascending."""
        bound = self.lower_bound()
        states = [
            st for st in self._state.values()
            if bound is None or st.winner_ts >= bound
        ]
        states.sort(key=lambda st: (st.winner_ts, st.rid))
        return [dict(st.winner) for st in states]

    def stats(self):
        return {
            "seen": self._seq,
            "kept_ids": len(self._state),
            "duplicates": self.duplicates,
            "conflicts": self.conflicts,
            "bad": self.bad,
            "evicted": self.evicted,
            "max_ts": self.max_ts,
            "lower_bound": self.lower_bound(),
        }
