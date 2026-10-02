"""Core sessionization logic.

Events are ``{key, ts, id}`` mappings.  For each key, events are grouped into
sessions over event time: two adjacent events belong to the same session when
their gap is ``<= gap``; a gap of ``gap + 1`` splits.  Several events of the
same key at the same timestamp each count individually.

The watermark is ``WM = max_ts - late`` where ``max_ts`` is the maximum event
time seen so far for the key.  A session is emitted (``ADD``) only when it is
final, i.e. ``end + gap <= WM``.

An event arriving after a larger ``ts`` was already seen is late.  It is
accepted when ``ts >= max_ts - late`` and silently dropped otherwise.  An
accepted event is inserted into the session structure and may merge existing
sessions, including already-finalized ones.  When a merge touches sessions
that were already emitted as final, those sessions are retracted
(``RETRACT``) and the merged session is emitted (``ADD``) once it is final
again.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Mapping, Tuple

ADD = "ADD"
RETRACT = "RETRACT"


def ids_hash(ids: Iterable[str]) -> str:
    """sha256 hex digest of the sorted ids concatenated together."""
    return hashlib.sha256(
        "".join(sorted(str(i) for i in ids)).encode("utf-8")
    ).hexdigest()


@dataclass
class Session:
    key: str
    start: int
    end: int
    count: int
    ids: str

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "start": self.start,
            "end": self.end,
            "count": self.count,
            "ids": self.ids,
        }


@dataclass
class _SessionState:
    """Internal mutable session: sorted list of (ts, id) events."""

    events: List[Tuple[int, str]] = field(default_factory=list)

    @property
    def start(self) -> int:
        return self.events[0][0]

    @property
    def end(self) -> int:
        return self.events[-1][0]

    def absorb(self, other: "_SessionState") -> None:
        self.events.extend(other.events)
        self.events.sort()

    def to_session(self, key: str) -> Session:
        return Session(
            key=key,
            start=self.start,
            end=self.end,
            count=len(self.events),
            ids=ids_hash(eid for _, eid in self.events),
        )


class _KeyState:
    """Streaming session state for a single key.

    Invariant: ``open`` and ``finalized`` together are sorted by start and
    pairwise separated by more than ``gap``.
    """

    def __init__(self, gap: int, late: int) -> None:
        self.gap = gap
        self.late = late
        self.max_ts: int | None = None
        self.open: List[_SessionState] = []
        self.finalized: List[_SessionState] = []

    def add_event(self, key: str, ts: int, eid: str) -> List[dict]:
        """Insert one event; return RETRACT/ADD output records it triggers."""
        if self.max_ts is not None and ts < self.max_ts - self.late:
            return []  # beyond allowed lateness: dropped
        if self.max_ts is None or ts > self.max_ts:
            self.max_ts = ts

        outputs: List[dict] = []
        singleton = _SessionState(events=[(ts, eid)])

        # Re-cluster all sessions (finalized + open + the new singleton) and
        # merge any whose spans come within ``gap`` of each other.
        candidates = sorted(
            self.finalized + self.open + [singleton],
            key=lambda s: (s.start, s.end),
        )
        finalized_ids = {id(s) for s in self.finalized}
        new_open: List[_SessionState] = []
        new_finalized: List[_SessionState] = []

        cluster = [candidates[0]]
        cluster_end = candidates[0].end

        def flush() -> None:
            nonlocal cluster
            if len(cluster) == 1 and id(cluster[0]) in finalized_ids:
                new_finalized.append(cluster[0])  # untouched finalized session
                return
            merged = _SessionState()
            for sess in cluster:
                merged.absorb(sess)
            for sess in cluster:
                if id(sess) in finalized_ids:
                    outputs.append(
                        {"type": RETRACT, "session": sess.to_session(key).to_dict()}
                    )
            new_open.append(merged)

        for sess in candidates[1:]:
            if sess.start - cluster_end <= self.gap:
                cluster.append(sess)
                if sess.end > cluster_end:
                    cluster_end = sess.end
            else:
                flush()
                cluster = [sess]
                cluster_end = sess.end
        flush()

        self.open = new_open
        self.finalized = new_finalized

        # Finalize open sessions whose end + gap is at or behind the watermark.
        watermark = self.max_ts - self.late
        still_open: List[_SessionState] = []
        for sess in self.open:
            if sess.end + self.gap <= watermark:
                self.finalized.append(sess)
                outputs.append(
                    {"type": ADD, "session": sess.to_session(key).to_dict()}
                )
            else:
                still_open.append(sess)
        self.open = still_open
        self.finalized.sort(key=lambda s: s.start)
        return outputs


def process_events(
    events: Iterable[Mapping], gap: int, late: int
) -> List[dict]:
    """Process events in arrival order; return the ADD/RETRACT output stream."""
    states: Dict[str, _KeyState] = {}
    outputs: List[dict] = []
    for event in events:
        key = event["key"]
        state = states.get(key)
        if state is None:
            state = states[key] = _KeyState(gap, late)
        outputs.extend(state.add_event(key, event["ts"], event["id"]))
    return outputs


def sessionize(events: Iterable[Mapping], gap: int, late: int) -> List[dict]:
    """Return the net set of final sessions after processing all events."""
    live: Dict[Tuple, dict] = {}
    for record in process_events(events, gap, late):
        session = record["session"]
        ident = (
            session["key"],
            session["start"],
            session["end"],
            session["count"],
            session["ids"],
        )
        if record["type"] == ADD:
            live[ident] = session
        else:
            live.pop(ident, None)
    return sorted(live.values(), key=lambda s: (s["key"], s["start"]))
