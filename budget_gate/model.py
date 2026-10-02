"""Core data model: subjects (DAG), quota rules, windows, reservations."""
from __future__ import annotations

from dataclasses import dataclass, field

from . import timeutil

WINDOW_BUSINESS_DAY = "business_day"
WINDOW_CALENDAR = "calendar"
WINDOW_ROLLING = "rolling"

CALENDAR_UNITS = ("week", "month")

STATUS_PENDING = "pending"
STATUS_CONFIRMED = "confirmed"
STATUS_CANCELLED = "cancelled"
STATUS_EXPIRED = "expired"

ACTIVE_STATUSES = (STATUS_PENDING, STATUS_CONFIRMED)


@dataclass(frozen=True)
class WindowSpec:
    """One budget window inside a quota rule.

    kind=business_day: capacity per local day (tz required).
    kind=calendar:     capacity per local ISO week or month (tz + unit).
    kind=rolling:      capacity over any sliding real-time interval of
                       ``seconds`` length, evaluated at true UTC instants.
    """

    kind: str
    capacity: int
    tz: str | None = None
    unit: str | None = None
    seconds: float | None = None

    def __post_init__(self):
        if self.kind not in (WINDOW_BUSINESS_DAY, WINDOW_CALENDAR, WINDOW_ROLLING):
            raise ValueError(f"unknown window kind: {self.kind!r}")
        if not isinstance(self.capacity, int) or self.capacity < 0:
            raise ValueError("capacity must be a non-negative integer")
        if self.kind == WINDOW_BUSINESS_DAY:
            if not self.tz:
                raise ValueError("business_day window requires tz")
            timeutil.load_timezone(self.tz)
        elif self.kind == WINDOW_CALENDAR:
            if not self.tz or self.unit not in CALENDAR_UNITS:
                raise ValueError("calendar window requires tz and unit week|month")
            timeutil.load_timezone(self.tz)
        else:
            if not isinstance(self.seconds, (int, float)) or self.seconds <= 0:
                raise ValueError("rolling window requires positive seconds")

    @property
    def window_id(self) -> str:
        if self.kind == WINDOW_BUSINESS_DAY:
            return f"business_day[{self.tz}]"
        if self.kind == WINDOW_CALENDAR:
            return f"calendar_{self.unit}[{self.tz}]"
        return f"rolling[{self.seconds}s]"

    def bucket_key(self, execute_at: float) -> str | None:
        """Static bucket for day/calendar windows; rolling windows are
        evaluated dynamically against real instants and return None."""
        if self.kind == WINDOW_BUSINESS_DAY:
            return timeutil.day_key(execute_at, self.tz)
        if self.kind == WINDOW_CALENDAR:
            if self.unit == "week":
                return timeutil.week_key(execute_at, self.tz)
            return timeutil.month_key(execute_at, self.tz)
        return None

    def to_dict(self) -> dict:
        d = {"type": self.kind, "capacity": self.capacity}
        if self.tz is not None:
            d["tz"] = self.tz
        if self.unit is not None:
            d["unit"] = self.unit
        if self.seconds is not None:
            d["seconds"] = self.seconds
        return d

    @staticmethod
    def from_dict(d: dict) -> "WindowSpec":
        return WindowSpec(
            kind=d["type"],
            capacity=d["capacity"],
            tz=d.get("tz"),
            unit=d.get("unit"),
            seconds=d.get("seconds"),
        )


@dataclass
class QuotaRule:
    """A named quota attached to one subject node; consumed by the whole
    subtree below that node (shared parent quota)."""

    rule_id: str
    subject: str
    windows: list[WindowSpec] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "rule_id": self.rule_id,
            "subject": self.subject,
            "windows": [w.to_dict() for w in self.windows],
        }

    @staticmethod
    def from_dict(d: dict) -> "QuotaRule":
        return QuotaRule(
            rule_id=d["rule_id"],
            subject=d["subject"],
            windows=[WindowSpec.from_dict(w) for w in d["windows"]],
        )


@dataclass
class Reservation:
    id: str
    version: int
    subject: str
    amount: int
    execute_at: float
    confirm_by: float
    status: str
    created_at: float
    rule_ids: list[str] = field(default_factory=list)
    # rule_id -> {window_id -> bucket key} for day/calendar windows
    buckets: dict[str, dict[str, str]] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "version": self.version,
            "subject": self.subject,
            "amount": self.amount,
            "execute_at": self.execute_at,
            "confirm_by": self.confirm_by,
            "status": self.status,
            "created_at": self.created_at,
            "rule_ids": list(self.rule_ids),
            "buckets": {r: dict(b) for r, b in self.buckets.items()},
        }

    @staticmethod
    def from_dict(d: dict) -> "Reservation":
        return Reservation(
            id=d["id"],
            version=d["version"],
            subject=d["subject"],
            amount=d["amount"],
            execute_at=d["execute_at"],
            confirm_by=d["confirm_by"],
            status=d["status"],
            created_at=d["created_at"],
            rule_ids=list(d["rule_ids"]),
            buckets={r: dict(b) for r, b in d["buckets"].items()},
        )


@dataclass
class GateState:
    # subject name -> list of parent names (DAG, multiple inheritance ok)
    subjects: dict[str, list[str]] = field(default_factory=dict)
    rules: dict[str, QuotaRule] = field(default_factory=dict)
    # id -> latest reservation (any status)
    reservations: dict[str, Reservation] = field(default_factory=dict)
    # id -> {"hash": str, "result": dict} for idempotent replay
    request_log: dict[str, dict] = field(default_factory=dict)
    # id -> last issued version number
    versions: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "subjects": {s: list(p) for s, p in self.subjects.items()},
            "rules": {r: rule.to_dict() for r, rule in self.rules.items()},
            "reservations": {i: r.to_dict() for i, r in self.reservations.items()},
            "request_log": self.request_log,
            "versions": dict(self.versions),
        }

    @staticmethod
    def from_dict(d: dict) -> "GateState":
        return GateState(
            subjects={s: list(p) for s, p in d.get("subjects", {}).items()},
            rules={r: QuotaRule.from_dict(v) for r, v in d.get("rules", {}).items()},
            reservations={
                i: Reservation.from_dict(v) for i, v in d.get("reservations", {}).items()
            },
            request_log=dict(d.get("request_log", {})),
            versions=dict(d.get("versions", {})),
        )
