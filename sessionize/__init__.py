"""Event-time sessionization with watermarks, late events and retractions.

Semantics
---------
* Events are ``(key, ts, id)`` triples and are sessionized per ``key`` in
  event time: adjacent events (sorted by ``ts``) whose timestamps differ by
  at most ``gap`` belong to the same session; a difference of ``gap + 1``
  or more splits sessions.  Several events of one key at the same timestamp
  are counted individually.
* The per-key watermark is ``WM = max_ts - late``.  A session is emitted as
  FINAL only when ``end + gap <= WM``.
* A late event (``ts < WM``) is *legal* when it still merges with at least
  one existing session of its key; it is then inserted and may merge
  several old sessions into one.  If any of the merged sessions was already
  FINAL, a ``RETRACT`` record listing the old sessions is emitted followed
  by an ``ADD`` record with the new merged session.  A late event that
  merges nothing exceeds the allowed lateness and is dropped (``DROP``).
* Sessions are represented as ``{key, start, end, count, ids}`` where
  ``ids`` is the sha256 hex digest of the sorted event ids concatenated
  together.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

__all__ = ["Session", "Sessionizer", "compute_sessions", "ids_hash"]

__version__ = "1.0.0"


def ids_hash(ids):
    """sha256 hex digest of the sorted ids concatenated together."""
    return hashlib.sha256(
        "".join(sorted(str(i) for i in ids)).encode("utf-8")
    ).hexdigest()


@dataclass(frozen=True)
class Session:
    """A finalized or in-progress session."""

    key: object
    start: object
    end: object
    count: int
    ids: str  # sha256 hex digest of the sorted, concatenated event ids

    def to_dict(self):
        return {
            "key": self.key,
            "start": self.start,
            "end": self.end,
            "count": self.count,
            "ids": self.ids,
        }


def compute_sessions(key, events, gap):
    """Sessionize ``events`` (iterable of ``(ts, id)``) for one ``key``.

    Adjacent events in event-time order whose timestamps differ by at most
    ``gap`` share a session; a larger difference splits sessions.
    """
    ordered = sorted(events, key=lambda e: (e[0], str(e[1])))
    sessions = []
    start = prev = None
    ids = []
    count = 0
    for ts, ident in ordered:
        if prev is not None and ts - prev > gap:
            sessions.append(Session(key, start, prev, count, ids_hash(ids)))
            start = None
            ids = []
            count = 0
        if start is None:
            start = ts
        ids.append(ident)
        count += 1
        prev = ts
    if count:
        sessions.append(Session(key, start, prev, count, ids_hash(ids)))
    return sessions


class Sessionizer:
    """Streaming per-key sessionizer with watermark and retraction support."""

    def __init__(self, gap, late):
        if gap < 0 or late < 0:
            raise ValueError("gap and late must be non-negative")
        self.gap = gap
        self.late = late
        self._events = {}  # key -> list of (ts, id)
        self._maxts = {}   # key -> maximum ts seen
        self._finals = {}  # key -> set of Session currently emitted as FINAL

    def watermark(self, key):
        """Current watermark for ``key`` (``None`` before any event)."""
        maxts = self._maxts.get(key)
        return None if maxts is None else maxts - self.late

    def sessions(self, key):
        """Current sessions of ``key`` (final and in-progress)."""
        return compute_sessions(key, self._events.get(key, ()), self.gap)

    def finals(self, key):
        """Sessions of ``key`` currently emitted as FINAL, sorted by start."""
        return sorted(self._finals.get(key, ()), key=lambda s: (s.start, s.end))

    def _merges_existing(self, key, ts):
        for session in self.sessions(key):
            if session.start - self.gap <= ts <= session.end + self.gap:
                return True
        return False

    def add(self, key, ts, ident):
        """Ingest one event; return a list of output records.

        Record types: ``FINAL`` (newly finalized session),
        ``RETRACT`` + ``ADD`` (legal late event merged finalized sessions),
        ``DROP`` (event exceeds the allowed lateness).
        """
        wm = self.watermark(key)
        if wm is not None and ts < wm and not self._merges_existing(key, ts):
            return [{
                "type": "DROP",
                "key": key,
                "ts": ts,
                "id": ident,
                "reason": "exceeds allowed lateness",
            }]

        self._events.setdefault(key, []).append((ts, ident))
        if key not in self._maxts or ts > self._maxts[key]:
            self._maxts[key] = ts
        wm = self._maxts[key] - self.late

        new_sessions = self.sessions(key)
        new_identity = set(new_sessions)
        finals = self._finals.setdefault(key, set())
        out = []

        retracted = sorted(
            (f for f in finals if f not in new_identity),
            key=lambda s: (s.start, s.end),
        )
        if retracted:
            merged = next(s for s in new_sessions if s.start <= ts <= s.end)
            out.append({
                "type": "RETRACT",
                "sessions": [s.to_dict() for s in retracted],
            })
            out.append({"type": "ADD", **merged.to_dict()})
            finals.difference_update(retracted)
            if merged.end + self.gap <= wm:
                finals.add(merged)

        for session in new_sessions:
            if session.end + self.gap <= wm and session not in finals:
                finals.add(session)
                out.append({"type": "FINAL", **session.to_dict()})
        return out
