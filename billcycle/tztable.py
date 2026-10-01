"""Offline timezone conversion tables.

No system tzdata is required: a small set of zones is built
algorithmically from their published transition rules and kept in
memory, so local<->UTC conversion is deterministic and fully offline.

Policies for awkward local times:
  - repeated local time (DST fall-back): ``repeat_policy`` must be
    ``earlier`` / ``later`` / ``reject`` -- the choice is explicit and
    recorded in the occurrence steps.
  - nonexistent local time (DST spring-forward): ``gap_policy`` is
    ``reject`` or ``shift_forward`` (first valid local time at/after).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta

EPOCH = datetime(1970, 1, 1)
HOUR = 3600

GAP_REJECT = "reject"
GAP_SHIFT_FORWARD = "shift_forward"
REPEAT_EARLIER = "earlier"
REPEAT_LATER = "later"
REPEAT_REJECT = "reject"

GAP_POLICIES = (GAP_REJECT, GAP_SHIFT_FORWARD)
REPEAT_POLICIES = (REPEAT_EARLIER, REPEAT_LATER, REPEAT_REJECT)


def to_epoch(dt: datetime) -> int:
    """Naive datetime (interpreted as UTC) -> epoch seconds."""
    return int((dt - EPOCH).total_seconds())


def from_epoch(ts: int) -> datetime:
    """Epoch seconds -> naive datetime in UTC."""
    return EPOCH + timedelta(seconds=ts)


def iso_utc(ts: int) -> str:
    return from_epoch(ts).strftime("%Y-%m-%dT%H:%M:%SZ")


def _fmt_offset(offset: int) -> str:
    sign = "+" if offset >= 0 else "-"
    total = abs(offset)
    return f"{sign}{total // HOUR:02d}:{(total % HOUR) // 60:02d}"


@dataclass(frozen=True)
class Transition:
    utc: int      # epoch second at which the new offset takes effect
    offset: int   # seconds east of UTC, in effect at/after ``utc``


class Zone:
    """An offline timezone: a base offset plus ordered transitions."""

    def __init__(self, name: str, base_offset: int, transitions=()):
        self.name = name
        self.base_offset = base_offset
        self.transitions = tuple(sorted(transitions, key=lambda t: t.utc))

    def offset_at(self, utc_ts: int) -> int:
        offset = self.base_offset
        for trans in self.transitions:
            if utc_ts >= trans.utc:
                offset = trans.offset
            else:
                break
        return offset

    def utc_to_local(self, utc_ts: int) -> datetime:
        return from_epoch(utc_ts + self.offset_at(utc_ts))

    def local_candidates(self, local: datetime) -> list[int]:
        """All UTC epochs whose local representation equals ``local``.

        Returns 0 epochs for a nonexistent local time (spring-forward
        gap), 1 for a normal time, 2 for a repeated time (fall-back).
        """
        naive = local.replace(tzinfo=None)
        offsets = {self.base_offset}
        offsets.update(t.offset for t in self.transitions)
        found = []
        for off in offsets:
            cand = to_epoch(naive) - off
            if self.offset_at(cand) == off:
                found.append(cand)
        return sorted(set(found))

    def __repr__(self):  # pragma: no cover - debugging aid
        return f"Zone({self.name!r})"


def resolve_local(zone: Zone, local: datetime, gap_policy: str,
                  repeat_policy: str) -> tuple[int | None, list[str]]:
    """Resolve a naive local datetime to a UTC epoch.

    Returns ``(epoch_or_None, steps)``.  ``None`` means the occurrence
    was rejected by policy; the reason is recorded in ``steps``.
    """
    if gap_policy not in GAP_POLICIES:
        raise ValueError(f"unknown gap_policy: {gap_policy!r}")
    if repeat_policy not in REPEAT_POLICIES:
        raise ValueError(f"unknown repeat_policy: {repeat_policy!r}")
    steps: list[str] = []
    cands = zone.local_candidates(local)
    stamp = local.strftime("%Y-%m-%dT%H:%M:%S")
    if len(cands) == 1:
        steps.append(
            f"local {stamp} maps unambiguously to UTC {iso_utc(cands[0])} "
            f"(offset {_fmt_offset(zone.offset_at(cands[0]))})")
        return cands[0], steps
    if len(cands) == 2:
        earlier, later = cands
        detail = (f"local {stamp} occurs twice (DST fall-back): "
                  f"{iso_utc(earlier)} and {iso_utc(later)}")
        if repeat_policy == REPEAT_EARLIER:
            steps.append(f"{detail}; repeat_policy=earlier chose {iso_utc(earlier)}")
            return earlier, steps
        if repeat_policy == REPEAT_LATER:
            steps.append(f"{detail}; repeat_policy=later chose {iso_utc(later)}")
            return later, steps
        steps.append(f"{detail}; repeat_policy=reject -> occurrence rejected")
        return None, steps
    # Nonexistent local time (spring-forward gap).
    detail = f"local {stamp} does not exist (DST spring-forward gap)"
    if gap_policy == GAP_SHIFT_FORWARD:
        probe = local
        for _ in range(240):  # scan forward one minute at a time
            probe += timedelta(minutes=1)
            found = zone.local_candidates(probe)
            if found:
                steps.append(
                    f"{detail}; gap_policy=shift_forward moved to first "
                    f"valid local time {probe.strftime('%Y-%m-%dT%H:%M:%S')} "
                    f"-> UTC {iso_utc(found[0])}")
                return found[0], steps
        raise ValueError(f"no valid local time within 4h of {stamp}")  # pragma: no cover
    steps.append(f"{detail}; gap_policy=reject -> occurrence rejected")
    return None, steps


# ---------------------------------------------------------------------------
# Zone construction (algorithmic, offline)
# ---------------------------------------------------------------------------

def _first_weekday(year: int, month: int, weekday: int) -> date:
    day = date(year, month, 1)
    return day + timedelta(days=(weekday - day.weekday()) % 7)


def _last_weekday(year: int, month: int, weekday: int) -> date:
    if month == 12:
        day = date(year, 12, 31)
    else:
        day = date(year, month + 1, 1) - timedelta(days=1)
    return day - timedelta(days=(day.weekday() - weekday) % 7)


def _build_new_york() -> Zone:
    """America/New_York, US DST rules in effect since 2007."""
    transitions = []
    for year in range(2000, 2101):
        # Starts: second Sunday of March, 02:00 local standard time.
        start_local = datetime.combine(
            _first_weekday(year, 3, 6) + timedelta(days=7),
            datetime.min.time()).replace(hour=2)
        # Ends: first Sunday of November, 02:00 local daylight time.
        end_local = datetime.combine(_first_weekday(year, 11, 6),
                                     datetime.min.time()).replace(hour=2)
        transitions.append(Transition(to_epoch(start_local) + 5 * HOUR, -4 * HOUR))
        transitions.append(Transition(to_epoch(end_local) + 4 * HOUR, -5 * HOUR))
    return Zone("America/New_York", -5 * HOUR, transitions)


def _build_london() -> Zone:
    """Europe/London, EU DST rules."""
    transitions = []
    for year in range(2000, 2101):
        start_utc = datetime.combine(_last_weekday(year, 3, 6),
                                     datetime.min.time()).replace(hour=1)
        end_utc = datetime.combine(_last_weekday(year, 10, 6),
                                   datetime.min.time()).replace(hour=1)
        transitions.append(Transition(to_epoch(start_utc), 1 * HOUR))
        transitions.append(Transition(to_epoch(end_utc), 0))
    return Zone("Europe/London", 0, transitions)


def _build_zones() -> dict[str, Zone]:
    zones = [
        Zone("UTC", 0),
        Zone("Asia/Shanghai", 8 * HOUR),
        _build_new_york(),
        _build_london(),
    ]
    return {z.name: z for z in zones}


_ZONES = _build_zones()


def available_zones() -> list[str]:
    return sorted(_ZONES)


def get_zone(name: str) -> Zone:
    try:
        return _ZONES[name]
    except KeyError:
        raise ValueError(
            f"unknown zone {name!r}; available: {', '.join(available_zones())}"
        ) from None
