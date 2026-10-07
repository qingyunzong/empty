"""Multi-layer calendar budget gate.

Linearization model
-------------------
Every mutating operation (reserve / confirm / cancel / timeout /
quota update) takes a single lock, first applies all due expirations at
the operation's ``now``, then appends one event to the ordered event log
and mutates state.  The log sequence number is the linearization order.

Idempotency & versions
----------------------
Each idempotency id owns a monotonically increasing version.  While a
hold is live (held/confirmed) a replayed reserve with the identical
payload returns the stored result; a different payload conflicts.  Once
a hold reaches a terminal state (cancelled/expired) the id may be reused
and gets the next version.  Confirm/cancel may carry the version they
target: a stale version is a no-op, so a late cancel (or a late expiry
timer) can never release quota belonging to a newer request with the
same id.  Expiry events always name the (id, version) they kill.

Hierarchy
---------
Subjects sit in a DAG of quota nodes.  A reservation charges the
subject's own windows plus every ancestor's, deduplicated by node id, so
a shared parent quota reached through several inheritance paths is
charged exactly once.
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from .errors import (
    GateError,
    GateInternalError,
    IdempotencyConflict,
    UnknownNode,
    UnknownRequest,
    UnknownWindow,
)
from .timeutil import TimezoneTable, fmt_ts, parse_ts
from .windows import CalendarWindow, RollingWindow, UsageEntry, WindowBase

HELD = "held"
CONFIRMED = "confirmed"
CANCELLED = "cancelled"
EXPIRED = "expired"
ACTIVE = (HELD, CONFIRMED)
TERMINAL = (CANCELLED, EXPIRED)


class SimulatedCrash(GateError):
    """Raised by the fault-injection hook to model a crash after the
    durable write but before the response reached the caller."""


@dataclass
class Hold:
    request_id: str
    version: int
    subject: str
    amount: int
    execute_at: datetime
    confirm_deadline: datetime
    state: str
    fingerprint: str
    charged: list[tuple[str, str]] = field(default_factory=list)
    result: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "request_id": self.request_id,
            "version": self.version,
            "subject": self.subject,
            "amount": self.amount,
            "execute_at": fmt_ts(self.execute_at),
            "confirm_deadline": fmt_ts(self.confirm_deadline),
            "state": self.state,
            "fingerprint": self.fingerprint,
            "charged": [list(c) for c in self.charged],
            "result": self.result,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Hold":
        return cls(
            request_id=data["request_id"],
            version=data["version"],
            subject=data["subject"],
            amount=data["amount"],
            execute_at=parse_ts(data["execute_at"]),
            confirm_deadline=parse_ts(data["confirm_deadline"]),
            state=data["state"],
            fingerprint=data["fingerprint"],
            charged=[tuple(c) for c in data["charged"]],
            result=data["result"],
        )


def _fingerprint(subject, amount, execute_at, confirm_deadline) -> str:
    return json.dumps(
        {
            "subject": subject,
            "amount": amount,
            "execute_at": fmt_ts(execute_at),
            "confirm_deadline": fmt_ts(confirm_deadline),
        },
        sort_keys=True,
    )


class BudgetGate:
    def __init__(self, config: dict, *, clock=None, after_commit=None):
        self._config = config
        self._tztab = TimezoneTable(config.get("timezones", {}))
        self._parents: dict[str, list[str]] = {}
        self._windows: dict[tuple[str, str], WindowBase] = {}
        self._node_windows: dict[str, list[WindowBase]] = {}
        for node_id, spec in config.get("nodes", {}).items():
            self._parents[node_id] = list(spec.get("parents", []))
            self._node_windows[node_id] = []
            for wspec in spec.get("windows", []):
                window = self._build_window(wspec)
                key = (node_id, window.window_id)
                if key in self._windows:
                    raise GateError(f"duplicate window id {window.window_id!r} on node {node_id!r}")
                self._windows[key] = window
                self._node_windows[node_id].append(window)
        self._holds: dict[str, Hold] = {}
        self._versions: dict[str, int] = {}
        self._seq = 0
        self._log: list[dict] = []
        self._lock = threading.RLock()
        self._clock = clock or (lambda: datetime.now(tz=None).astimezone())
        self._after_commit = after_commit

    # ------------------------------------------------------------------
    # construction helpers
    def _build_window(self, wspec: dict) -> WindowBase:
        kind = wspec["kind"]
        if kind == "rolling":
            return RollingWindow(
                wspec["id"], wspec["capacity"], timedelta(seconds=wspec["duration_seconds"])
            )
        tz_alias = wspec["tz"]
        return CalendarWindow(
            wspec["id"], wspec["capacity"], kind, self._tztab.zone(tz_alias), tz_alias
        )

    @classmethod
    def restore(cls, snapshot: dict, *, clock=None, after_commit=None) -> "BudgetGate":
        gate = cls(snapshot["config"], clock=clock, after_commit=after_commit)
        gate._seq = snapshot["seq"]
        gate._versions = dict(snapshot["versions"])
        gate._log = list(snapshot["log"])
        gate._holds = {rid: Hold.from_dict(h) for rid, h in snapshot["holds"].items()}
        for hold in gate._holds.values():
            if hold.state in ACTIVE:
                entry = UsageEntry(hold.request_id, hold.version, hold.amount, hold.execute_at)
                for node_id, window_id in hold.charged:
                    gate._windows[(node_id, window_id)].add(entry)
        return gate

    # ------------------------------------------------------------------
    # internals
    def _now(self, now) -> datetime:
        return parse_ts(now) if now is not None else parse_ts(self._clock())

    def _append(self, event: dict) -> None:
        self._seq += 1
        event["seq"] = self._seq
        self._log.append(event)

    def _commit(self, event: dict) -> None:
        """Durable write point: log append + fault-injection hook."""
        self._append(event)
        if self._after_commit is not None:
            self._after_commit(event)

    def _related_nodes(self, subject: str) -> list[str]:
        if subject not in self._node_windows and subject not in self._parents:
            raise UnknownNode(f"unknown subject/node: {subject!r}")
        order, seen, stack = [], set(), [subject]
        while stack:
            node = stack.pop()
            if node in seen:
                continue  # dedupe: shared parents are charged once
            seen.add(node)
            order.append(node)
            stack.extend(self._parents.get(node, ()))
        return order

    def _release(self, hold: Hold) -> None:
        for node_id, window_id in hold.charged:
            self._windows[(node_id, window_id)].remove(hold.request_id, hold.version)
        hold.charged = []

    def _expire_due(self, now: datetime) -> list[dict]:
        """Apply versioned expiry timers due at ``now`` (linearized first)."""
        expired = []
        for hold in list(self._holds.values()):
            if hold.state == HELD and now > hold.confirm_deadline:
                # The timer only kills the (id, version) it was scheduled
                # for; the hold stored under the id IS that version here.
                hold.state = EXPIRED
                self._release(hold)
                event = {
                    "op": "expire",
                    "request_id": hold.request_id,
                    "version": hold.version,
                    "at": fmt_ts(now),
                }
                self._append(event)
                expired.append(event)
        return expired

    # ------------------------------------------------------------------
    # public operations
    def reserve(
        self,
        *,
        request_id: str,
        subject: str,
        amount: int,
        execute_at,
        confirm_deadline,
        now=None,
    ) -> dict:
        execute_at = parse_ts(execute_at)
        confirm_deadline = parse_ts(confirm_deadline)
        if not isinstance(amount, int) or amount <= 0:
            raise GateError("amount must be a positive integer")
        with self._lock:
            now = self._now(now)
            self._expire_due(now)
            fingerprint = _fingerprint(subject, amount, execute_at, confirm_deadline)

            existing = self._holds.get(request_id)
            if existing is not None and existing.state in ACTIVE:
                if existing.fingerprint == fingerprint:
                    return dict(existing.result, replayed=True)
                raise IdempotencyConflict(
                    f"request id {request_id!r} is live with a different payload"
                )

            version = self._versions.get(request_id, 0) + 1
            targets: list[tuple[str, WindowBase]] = []
            for node_id in self._related_nodes(subject):
                for window in self._node_windows.get(node_id, []):
                    targets.append((node_id, window))

            entry = UsageEntry(request_id, version, amount, execute_at)
            violations = []
            for node_id, window in targets:
                violation = window.check(entry)
                if violation is not None:
                    violations.append({"node": node_id, **violation})
            if violations:
                self._append(
                    {"op": "reserve", "request_id": request_id, "version": version,
                     "result": "rejected", "at": fmt_ts(now)}
                )
                return {
                    "status": "rejected",
                    "request_id": request_id,
                    "violations": violations,
                }

            applied: list[WindowBase] = []
            try:
                for _node_id, window in targets:
                    window.add(entry)
                    applied.append(window)
            except Exception as exc:  # full rollback of partial application
                for window in reversed(applied):
                    window.remove(request_id, version)
                raise GateInternalError(
                    "window apply failed; reservation fully rolled back"
                ) from exc

            hold = Hold(
                request_id=request_id,
                version=version,
                subject=subject,
                amount=amount,
                execute_at=execute_at,
                confirm_deadline=confirm_deadline,
                state=HELD,
                fingerprint=fingerprint,
                charged=[(nid, w.window_id) for nid, w in targets],
            )
            result = {
                "status": HELD,
                "request_id": request_id,
                "version": version,
                "charged": [
                    {"node": nid, "window": w.window_id} for nid, w in targets
                ],
            }
            hold.result = result
            self._holds[request_id] = hold
            self._versions[request_id] = version
            self._commit(
                {"op": "reserve", "request_id": request_id, "version": version,
                 "result": HELD, "at": fmt_ts(now)}
            )
            return dict(result)

    def confirm(self, request_id: str, *, version: int | None = None, now=None) -> dict:
        with self._lock:
            now = self._now(now)
            self._expire_due(now)
            hold = self._holds.get(request_id)
            if hold is None:
                raise UnknownRequest(request_id)
            if version is not None and version != hold.version:
                return {"status": "stale", "request_id": request_id,
                        "expected": version, "current": hold.version}
            if hold.state == CONFIRMED:
                return {"status": CONFIRMED, "request_id": request_id,
                        "version": hold.version, "replayed": True}
            if hold.state != HELD:
                return {"status": "rejected", "request_id": request_id,
                        "version": hold.version, "reason": f"hold is {hold.state}"}
            hold.state = CONFIRMED
            self._commit(
                {"op": "confirm", "request_id": request_id, "version": hold.version,
                 "at": fmt_ts(now)}
            )
            return {"status": CONFIRMED, "request_id": request_id, "version": hold.version}

    def cancel(self, request_id: str, *, version: int | None = None, now=None) -> dict:
        with self._lock:
            now = self._now(now)
            self._expire_due(now)
            hold = self._holds.get(request_id)
            if hold is None:
                raise UnknownRequest(request_id)
            if version is not None and version != hold.version:
                # Late cancel aimed at an older generation: must not touch
                # the quota of the newer request under the same id.
                return {"status": "stale", "request_id": request_id,
                        "expected": version, "current": hold.version}
            if hold.state == CANCELLED:
                return {"status": CANCELLED, "request_id": request_id,
                        "version": hold.version, "replayed": True}
            if hold.state != HELD:
                return {"status": "rejected", "request_id": request_id,
                        "version": hold.version, "reason": f"hold is {hold.state}"}
            hold.state = CANCELLED
            self._release(hold)
            self._commit(
                {"op": "cancel", "request_id": request_id, "version": hold.version,
                 "at": fmt_ts(now)}
            )
            return {"status": CANCELLED, "request_id": request_id, "version": hold.version}

    def run_due_timers(self, now=None) -> list[dict]:
        with self._lock:
            return self._expire_due(self._now(now))

    def set_capacity(self, node_id: str, window_id: str, capacity: int, *, now=None) -> dict:
        with self._lock:
            now = self._now(now)
            self._expire_due(now)
            key = (node_id, window_id)
            if key not in self._windows:
                raise UnknownWindow(f"{node_id}/{window_id}")
            window = self._windows[key]
            old = window.capacity
            window.set_capacity(capacity)
            self._commit(
                {"op": "set_capacity", "node": node_id, "window": window_id,
                 "old": old, "new": capacity, "at": fmt_ts(now)}
            )
            return {"status": "ok", "node": node_id, "window": window_id,
                    "old": old, "new": capacity}

    # ------------------------------------------------------------------
    # introspection
    def status(self) -> dict:
        with self._lock:
            return {
                "seq": self._seq,
                "holds": {rid: h.to_dict() for rid, h in self._holds.items()},
                "windows": {
                    f"{nid}/{w.window_id}": {
                        **w.describe(),
                        "entries": [e.to_dict() for e in w.all_entries()],
                    }
                    for (nid, _), w in self._windows.items()
                },
            }

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "config": self._config,
                "seq": self._seq,
                "versions": dict(self._versions),
                "log": list(self._log),
                "holds": {rid: h.to_dict() for rid, h in self._holds.items()},
            }

    def check_invariants(self) -> None:
        """Raise AssertionError if any internal consistency rule is broken."""
        with self._lock:
            active = [h for h in self._holds.values() if h.state in ACTIVE]
            for hold in active:
                for node_id, window_id in hold.charged:
                    window = self._windows[(node_id, window_id)]
                    matches = [
                        e for e in window.all_entries()
                        if e.hold_id == hold.request_id and e.version == hold.version
                    ]
                    assert len(matches) == 1, (
                        f"hold {hold.request_id} v{hold.version} charged "
                        f"{len(matches)}x in {node_id}/{window_id}"
                    )
                    assert matches[0].amount == hold.amount
            for (node_id, window_id), window in self._windows.items():
                entries = window.all_entries()
                keys = [(e.hold_id, e.version) for e in entries]
                assert len(keys) == len(set(keys)), (
                    f"duplicate entries in {node_id}/{window_id}"
                )
                live = {(h.request_id, h.version) for h in active}
                for e in entries:
                    assert (e.hold_id, e.version) in live, (
                        f"orphan entry {e.hold_id} v{e.version} in {node_id}/{window_id}"
                    )
                if isinstance(window, RollingWindow):
                    for point in {e.at for e in entries}:
                        used = window._usage_at(point, entries)
                        assert used <= window.capacity, (
                            f"rolling capacity exceeded at {point} in "
                            f"{node_id}/{window_id}: {used} > {window.capacity}"
                        )
                else:
                    buckets: dict[tuple, int] = {}
                    for e in entries:
                        key = window.bucket_key(e.at)
                        buckets[key] = buckets.get(key, 0) + e.amount
                    for key, used in buckets.items():
                        assert used <= window.capacity, (
                            f"calendar capacity exceeded in {node_id}/{window_id} "
                            f"bucket {key}: {used} > {window.capacity}"
                        )
