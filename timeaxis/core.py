"""Core time-axis primitives.

Distinguishes three concepts that must never be conflated:

- ``Instant``: a unique point on the UTC timeline (epoch seconds).
- ``LocalDateTime``: a wall-clock reading with no unique position on the
  timeline until a transition table is applied.
- ``Duration``: an elapsed amount of timeline seconds.

A ``TransitionTable`` is an explicit, ordered list of UTC-offset segments.
Historical non-whole-hour offsets (e.g. +05:45, +08:45:52) are supported.
"""
from __future__ import annotations

import calendar
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
NAIVE_EPOCH = datetime(1970, 1, 1)
ONE_SECOND = timedelta(seconds=1)


class TableError(ValueError):
    """Raised when a transition table is structurally invalid."""


def _dt_to_epoch(dt: datetime) -> int:
    return (dt - NAIVE_EPOCH) // ONE_SECOND


def _epoch_to_dt(epoch: int) -> datetime:
    return NAIVE_EPOCH + timedelta(seconds=epoch)


def parse_offset(value) -> int:
    """Parse an offset given as seconds (int) or '[+|-]HH:MM[:SS]' -> seconds."""
    if isinstance(value, bool):
        raise TableError(f"invalid offset: {value!r}")
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        text = value.strip()
        sign = 1
        if text.startswith("+"):
            text = text[1:]
        elif text.startswith("-"):
            sign = -1
            text = text[1:]
        parts = text.split(":")
        if len(parts) not in (2, 3):
            raise TableError(f"invalid offset: {value!r}")
        try:
            hours = int(parts[0])
            minutes = int(parts[1])
            seconds = int(parts[2]) if len(parts) == 3 else 0
        except ValueError:
            raise TableError(f"invalid offset: {value!r}") from None
        if not (0 <= minutes <= 59 and 0 <= seconds <= 59) or hours < 0:
            raise TableError(f"invalid offset: {value!r}")
        return sign * (hours * 3600 + minutes * 60 + seconds)
    raise TableError(f"invalid offset: {value!r}")


def format_offset(seconds: int) -> str:
    sign = "+" if seconds >= 0 else "-"
    rest = abs(seconds)
    hours, rest = divmod(rest, 3600)
    minutes, secs = divmod(rest, 60)
    if secs:
        return f"{sign}{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{sign}{hours:02d}:{minutes:02d}"


@dataclass(frozen=True, order=True)
class Instant:
    """A unique point on the UTC timeline, in epoch seconds."""
    epoch_seconds: int

    @classmethod
    def from_iso(cls, text: str) -> "Instant":
        dt = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
        if dt.tzinfo is None:
            raise ValueError(f"instant requires a UTC offset: {text!r}")
        utc = dt.astimezone(timezone.utc)
        return cls((utc - EPOCH) // ONE_SECOND)

    def to_iso(self) -> str:
        return (EPOCH + timedelta(seconds=self.epoch_seconds)).isoformat().replace("+00:00", "Z")

    def add(self, duration: "Duration") -> "Instant":
        """Timeline arithmetic: shift by elapsed seconds."""
        return Instant(self.epoch_seconds + duration.seconds)

    def __add__(self, duration: "Duration") -> "Instant":
        return self.add(duration)


@dataclass(frozen=True, order=True)
class LocalDateTime:
    """A wall-clock reading; not a unique timeline point by itself."""
    dt: datetime

    def __post_init__(self):
        if self.dt.tzinfo is not None:
            raise ValueError("LocalDateTime must be timezone-naive")

    @classmethod
    def from_iso(cls, text: str) -> "LocalDateTime":
        dt = datetime.fromisoformat(text.strip())
        return cls(dt)

    def to_iso(self) -> str:
        return self.dt.isoformat()

    def add_days(self, days: int) -> "LocalDateTime":
        """Wall-clock arithmetic: calendar days, not 86400-second steps."""
        return LocalDateTime(self.dt + timedelta(days=days))

    def add_months(self, months: int) -> "LocalDateTime":
        """Wall-clock arithmetic: calendar months, clamping the day-of-month."""
        total = self.dt.year * 12 + (self.dt.month - 1) + months
        year, month0 = divmod(total, 12)
        month = month0 + 1
        day = min(self.dt.day, calendar.monthrange(year, month)[1])
        return LocalDateTime(self.dt.replace(year=year, month=month, day=day))


@dataclass(frozen=True)
class Duration:
    """Elapsed timeline seconds."""
    seconds: int

    @classmethod
    def from_seconds(cls, seconds: int) -> "Duration":
        return cls(int(seconds))


@dataclass(frozen=True)
class Segment:
    """One UTC-offset segment: [utc_start, utc_end) with a fixed offset.

    ``utc_start``/``utc_end`` are epoch seconds; ``None`` means unbounded.
    """
    index: int
    utc_start: int | None
    utc_end: int | None
    offset: int

    def contains_epoch(self, epoch: int) -> bool:
        return (self.utc_start is None or epoch >= self.utc_start) and \
               (self.utc_end is None or epoch < self.utc_end)

    def local_start_epoch(self) -> int | None:
        return None if self.utc_start is None else self.utc_start + self.offset

    def local_end_epoch(self) -> int | None:
        return None if self.utc_end is None else self.utc_end + self.offset

    def contains_local_epoch(self, local_epoch: int) -> bool:
        start = self.local_start_epoch()
        end = self.local_end_epoch()
        return (start is None or local_epoch >= start) and \
               (end is None or local_epoch < end)


@dataclass(frozen=True)
class Candidate:
    """One possible instant for a wall-clock reading, with its source segment."""
    instant: Instant
    segment: Segment


@dataclass(frozen=True)
class UtcInterval:
    """A UTC interval produced by converting a local interval.

    Carries its boundary openness and the source segment it came from, so
    duplicate coverage of a local range stays attributable.
    """
    start: Instant
    end: Instant
    start_closed: bool
    end_closed: bool
    segment: Segment

    def to_dict(self) -> dict:
        return {
            "utc_start": self.start.to_iso(),
            "utc_end": self.end.to_iso(),
            "start_closed": self.start_closed,
            "end_closed": self.end_closed,
            "segment_index": self.segment.index,
            "offset": format_offset(self.segment.offset),
        }


def _parse_instant_field(value) -> int | None:
    if value is None:
        return None
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str):
        return Instant.from_iso(value).epoch_seconds
    raise TableError(f"invalid instant field: {value!r}")


class TransitionTable:
    """An explicit, ordered, immutable UTC-offset transition table."""

    def __init__(self, segments: tuple[Segment, ...]):
        self._segments = segments

    @property
    def segments(self) -> tuple[Segment, ...]:
        return self._segments

    @classmethod
    def from_spec(cls, spec) -> "TransitionTable":
        """Build and fully validate a table; raises TableError on any problem.

        Spec entries: {"utc_start": iso|epoch|null, "utc_end": optional,
        "offset": "+HH:MM[:SS]"|seconds}.  A missing utc_end extends to the
        next segment's start (unbounded for the last segment).
        """
        if isinstance(spec, dict):
            spec = spec.get("segments")
        if not spec:
            raise TableError("transition table must contain at least one segment")
        raw = []
        for entry in spec:
            if "offset" not in entry:
                raise TableError("segment missing 'offset'")
            raw.append([
                _parse_instant_field(entry.get("utc_start")),
                _parse_instant_field(entry.get("utc_end")),
                parse_offset(entry["offset"]),
            ])
        for i, (start, _end, _off) in enumerate(raw):
            if start is None and i != 0:
                raise TableError("only the first segment may have an open start")
            if i > 0 and start is not None and raw[i - 1][0] is not None \
                    and start <= raw[i - 1][0]:
                raise TableError(
                    f"segment {i} start does not strictly increase: overlapping segments")
        segments = []
        for i, (start, end, offset) in enumerate(raw):
            next_start = raw[i + 1][0] if i + 1 < len(raw) else None
            if end is not None and next_start is not None and end > next_start:
                raise TableError(
                    f"segment {i} ends after segment {i + 1} starts: overlapping segments")
            effective_end = end if end is not None else next_start
            if start is not None and effective_end is not None and effective_end <= start:
                raise TableError(f"segment {i} ends at or before its start")
            segments.append(Segment(i, start, effective_end, offset))
        return cls(tuple(segments))

    def to_spec(self) -> list[dict]:
        out = []
        for seg in self._segments:
            out.append({
                "utc_start": None if seg.utc_start is None
                else Instant(seg.utc_start).to_iso(),
                "utc_end": None if seg.utc_end is None
                else Instant(seg.utc_end).to_iso(),
                "offset": format_offset(seg.offset),
            })
        return out

    def to_json(self) -> str:
        return json.dumps({"segments": self.to_spec()}, indent=2)

    @classmethod
    def from_json(cls, text: str) -> "TransitionTable":
        return cls.from_spec(json.loads(text))

    def segment_at(self, instant: Instant) -> Segment:
        for seg in self._segments:
            if seg.contains_epoch(instant.epoch_seconds):
                return seg
        raise TableError(f"no segment covers instant {instant.to_iso()}")

    def offset_or_none(self, epoch_seconds: int) -> int | None:
        for seg in self._segments:
            if seg.contains_epoch(epoch_seconds):
                return seg.offset
        return None

    def instant_to_local(self, instant: Instant) -> LocalDateTime:
        seg = self.segment_at(instant)
        return LocalDateTime(_epoch_to_dt(instant.epoch_seconds + seg.offset))

    def local_to_instant(self, local: LocalDateTime) -> list[Candidate]:
        """Return 0, 1 or 2 candidate instants for a wall-clock reading.

        0: the reading falls in a gap (forward jump).  2: it falls in a fold
        (backward jump).  Candidates are sorted chronologically by instant.
        """
        local_epoch = _dt_to_epoch(local.dt)
        out = [
            Candidate(Instant(local_epoch - seg.offset), seg)
            for seg in self._segments
            if seg.contains_local_epoch(local_epoch)
        ]
        out.sort(key=lambda c: c.instant.epoch_seconds)
        return out

    def local_interval_to_utc(
        self,
        start: LocalDateTime,
        end: LocalDateTime,
        start_closed: bool = True,
        end_closed: bool = False,
    ) -> list[UtcInterval]:
        """Split a local interval into the union of UTC intervals it maps to.

        Boundary openness is preserved through the mapping, and every piece
        records the segment it originated from.
        """
        start_epoch = _dt_to_epoch(start.dt)
        end_epoch = _dt_to_epoch(end.dt)
        if end_epoch < start_epoch or (
            end_epoch == start_epoch and not (start_closed and end_closed)
        ):
            raise ValueError("empty local interval")
        out = []
        for seg in self._segments:
            seg_start = seg.local_start_epoch()
            seg_end = seg.local_end_epoch()
            if seg_start is not None and seg_start > start_epoch:
                eff_start, s_open = seg_start, False
            else:
                eff_start, s_open = start_epoch, not start_closed
            if seg_end is not None and seg_end <= end_epoch:
                eff_end, e_open = seg_end, True
            else:
                eff_end, e_open = end_epoch, not end_closed
            if eff_start > eff_end:
                continue
            if eff_start == eff_end and (s_open or e_open):
                continue
            out.append(UtcInterval(
                Instant(eff_start - seg.offset),
                Instant(eff_end - seg.offset),
                not s_open,
                not e_open,
                seg,
            ))
        return out

    def evidence(self) -> list[dict]:
        """Verifiable segmented mapping evidence: UTC range <-> local range."""
        out = []
        for seg in self._segments:
            local_start = seg.local_start_epoch()
            local_end = seg.local_end_epoch()
            out.append({
                "index": seg.index,
                "utc_start": None if seg.utc_start is None
                else Instant(seg.utc_start).to_iso(),
                "utc_end": None if seg.utc_end is None
                else Instant(seg.utc_end).to_iso(),
                "offset": format_offset(seg.offset),
                "offset_seconds": seg.offset,
                "local_start": None if local_start is None
                else _epoch_to_dt(local_start).isoformat(),
                "local_end": None if local_end is None
                else _epoch_to_dt(local_end).isoformat(),
            })
        return out
