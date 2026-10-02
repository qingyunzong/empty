"""BudgetGate: multi-layer calendar budget gate.

Linearization model
-------------------
Every public mutating operation (reserve / confirm / cancel / expire /
tick / set_quota) runs as a single critical section under one reentrant
lock; the order in which operations acquire the lock *is* the
linearization order. A reserve checks every applicable window of every
inherited quota rule and only then commits to all of them atomically --
a failure in any window leaves all windows untouched (no partial hold).

``tick`` expires due reservations in deterministic (confirm_by, id)
order. Timers are versioned: confirm/cancel/expire carry the reservation
version, so a late cancel aimed at an expired reservation can never
release the hold of a newer request that reused the same idempotency id.
"""
from __future__ import annotations

import hashlib
import json
import threading

from .model import (
    ACTIVE_STATUSES,
    STATUS_CANCELLED,
    STATUS_CONFIRMED,
    STATUS_EXPIRED,
    STATUS_PENDING,
    WINDOW_ROLLING,
    GateState,
    QuotaRule,
    Reservation,
    WindowSpec,
)


class GateError(Exception):
    """Client/protocol error (bad input, stale version, state conflict)."""

    def __init__(self, code: str, message: str, **details):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message, **self.details}


def _payload_hash(subject: str, amount: int, execute_at: float, confirm_by: float) -> str:
    canonical = json.dumps(
        {
            "subject": subject,
            "amount": amount,
            "execute_at": execute_at,
            "confirm_by": confirm_by,
        },
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


class BudgetGate:
    def __init__(self, state: GateState | None = None):
        self._lock = threading.RLock()
        self.state = state if state is not None else GateState()

    # ------------------------------------------------------------------
    # administration
    # ------------------------------------------------------------------
    def add_subject(self, subject: str, parents: list[str] | None = None) -> dict:
        with self._lock:
            if not subject:
                raise GateError("bad_input", "subject name required")
            parents = list(parents or [])
            for p in parents:
                if p not in self.state.subjects:
                    raise GateError("unknown_subject", f"unknown parent {p!r}")
            if subject in self.state.subjects:
                if self.state.subjects[subject] == parents:
                    return {"status": "ok", "subject": subject, "replayed": True}
                raise GateError("subject_exists", f"subject {subject!r} already exists")
            if subject in parents or self._reachable(parents, subject):
                raise GateError("cycle", "parent list would create a cycle")
            self.state.subjects[subject] = parents
            return {"status": "ok", "subject": subject}

    def _reachable(self, starts: list[str], target: str) -> bool:
        seen, stack = set(), list(starts)
        while stack:
            node = stack.pop()
            if node == target:
                return True
            if node in seen:
                continue
            seen.add(node)
            stack.extend(self.state.subjects.get(node, []))
        return False

    def set_quota(self, subject: str, rule_id: str, windows: list[WindowSpec]) -> dict:
        """Create or replace a quota rule. A capacity decrease takes effect
        at this linearization point: existing holds are grandfathered (they
        keep occupying) and new reserves must fit under the new capacity."""
        with self._lock:
            if subject not in self.state.subjects:
                raise GateError("unknown_subject", f"unknown subject {subject!r}")
            if not rule_id:
                raise GateError("bad_input", "rule_id required")
            if not windows:
                raise GateError("bad_input", "at least one window required")
            existing = self.state.rules.get(rule_id)
            if existing is not None and existing.subject != subject:
                raise GateError(
                    "rule_conflict",
                    f"rule {rule_id!r} already owned by {existing.subject!r}",
                )
            self.state.rules[rule_id] = QuotaRule(rule_id=rule_id, subject=subject,
                                                  windows=list(windows))
            return {"status": "ok", "rule_id": rule_id}

    # ------------------------------------------------------------------
    # ancestry / applicable rules
    # ------------------------------------------------------------------
    def _ancestors(self, subject: str) -> list[str]:
        """Subject plus all transitive parents, deduplicated (BFS)."""
        order, seen, stack = [], set(), [subject]
        while stack:
            node = stack.pop(0)
            if node in seen:
                continue
            seen.add(node)
            order.append(node)
            stack.extend(self.state.subjects.get(node, []))
        return order

    def _applicable_rules(self, subject: str) -> list[QuotaRule]:
        """Rules inherited by ``subject``. Each rule id appears once, so a
        shared parent quota reached via multiple inheritance paths is
        charged exactly once."""
        nodes = set(self._ancestors(subject))
        return [r for r in self.state.rules.values() if r.subject in nodes]

    # ------------------------------------------------------------------
    # occupancy
    # ------------------------------------------------------------------
    def _window_occupancy(self, rule: QuotaRule, window: WindowSpec,
                          execute_at: float, bucket: str | None) -> int:
        total = 0
        for res in self.state.reservations.values():
            if res.status not in ACTIVE_STATUSES or rule.rule_id not in res.rule_ids:
                continue
            if window.kind == WINDOW_ROLLING:
                lo = execute_at - window.seconds
                if lo < res.execute_at <= execute_at:
                    total += res.amount
            else:
                key = res.buckets.get(rule.rule_id, {}).get(window.window_id)
                if key is not None and key == bucket:
                    total += res.amount
        return total

    def occupancy_report(self, subject: str, execute_at: float) -> list[dict]:
        """Read-only snapshot of per-window occupancy for a hypothetical
        reservation by ``subject`` at ``execute_at``."""
        with self._lock:
            if subject not in self.state.subjects:
                raise GateError("unknown_subject", f"unknown subject {subject!r}")
            report = []
            for rule in self._applicable_rules(subject):
                for w in rule.windows:
                    bucket = w.bucket_key(execute_at)
                    report.append({
                        "rule_id": rule.rule_id,
                        "quota_subject": rule.subject,
                        "window": w.to_dict(),
                        "window_id": w.window_id,
                        "bucket": bucket,
                        "capacity": w.capacity,
                        "occupied": self._window_occupancy(rule, w, execute_at, bucket),
                    })
            return report

    # ------------------------------------------------------------------
    # reserve
    # ------------------------------------------------------------------
    def reserve(self, *, id: str, subject: str, amount: int, execute_at: float,
                confirm_by: float, now: float) -> dict:
        with self._lock:
            payload_hash = _payload_hash(subject, amount, execute_at, confirm_by)

            logged = self.state.request_log.get(id)
            existing = self.state.reservations.get(id)
            if logged is not None:
                if logged["hash"] == payload_hash:
                    # Idempotent replay of a previously processed request;
                    # checked before time-based validation because the
                    # original confirm_by may already be in the past.
                    return {**logged["result"], "replayed": True}
            self._validate_reserve(id, subject, amount, execute_at, confirm_by, now)
            if logged is not None:
                if existing is not None and existing.status in ACTIVE_STATUSES:
                    raise GateError(
                        "id_conflict",
                        f"id {id!r} already used by an active reservation",
                        id=id,
                    )
                # Prior request is terminal (or was rejected): this is a new
                # request reusing the id -> bump the version so stale timers
                # and late cancels aimed at the old version cannot touch it.

            rules = self._applicable_rules(subject)
            failures = []
            planned = []  # (rule, window, bucket)
            for rule in rules:
                for w in rule.windows:
                    bucket = w.bucket_key(execute_at)
                    occupied = self._window_occupancy(rule, w, execute_at, bucket)
                    planned.append((rule, w, bucket))
                    if occupied + amount > w.capacity:
                        failures.append({
                            "rule_id": rule.rule_id,
                            "quota_subject": rule.subject,
                            "window": w.to_dict(),
                            "window_id": w.window_id,
                            "bucket": bucket,
                            "capacity": w.capacity,
                            "occupied": occupied,
                            "requested": amount,
                            "available": max(0, w.capacity - occupied),
                        })

            if failures:
                # Atomicity: nothing was mutated; every window is untouched.
                result = {"status": "rejected", "id": id, "failures": failures}
                self.state.request_log[id] = {"hash": payload_hash, "result": result}
                return result

            version = self.state.versions.get(id, 0) + 1
            self.state.versions[id] = version
            buckets: dict[str, dict[str, str]] = {}
            for rule, w, bucket in planned:
                if bucket is not None:
                    buckets.setdefault(rule.rule_id, {})[w.window_id] = bucket
            reservation = Reservation(
                id=id,
                version=version,
                subject=subject,
                amount=amount,
                execute_at=execute_at,
                confirm_by=confirm_by,
                status=STATUS_PENDING,
                created_at=now,
                rule_ids=[rule.rule_id for rule in rules],
                buckets=buckets,
            )
            self.state.reservations[id] = reservation
            result = {"status": "reserved", "id": id, "version": version}
            self.state.request_log[id] = {"hash": payload_hash, "result": result}
            return result

    def _validate_reserve(self, id, subject, amount, execute_at, confirm_by, now):
        if not id:
            raise GateError("bad_input", "id required")
        if subject not in self.state.subjects:
            raise GateError("unknown_subject", f"unknown subject {subject!r}")
        if not isinstance(amount, int) or isinstance(amount, bool) or amount <= 0:
            raise GateError("bad_input", "amount must be a positive integer")
        for name, value in (("execute_at", execute_at), ("confirm_by", confirm_by),
                            ("now", now)):
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                raise GateError("bad_input", f"{name} must be a number")
        if confirm_by <= now:
            raise GateError("bad_input", "confirm_by must be later than now")

    # ------------------------------------------------------------------
    # lifecycle: confirm / cancel / expire
    # ------------------------------------------------------------------
    def _get_for_update(self, id: str, version: int) -> Reservation:
        res = self.state.reservations.get(id)
        if res is None:
            raise GateError("unknown_id", f"unknown reservation id {id!r}", id=id)
        if res.version != version:
            raise GateError(
                "stale_version",
                f"reservation {id!r} is at version {res.version}, "
                f"not {version}; refusing to touch a newer request",
                id=id,
                current_version=res.version,
            )
        return res

    def confirm(self, *, id: str, version: int, now: float) -> dict:
        with self._lock:
            res = self._get_for_update(id, version)
            if res.status == STATUS_CONFIRMED:
                return {"status": "confirmed", "id": id, "version": version,
                        "replayed": True}
            if res.status != STATUS_PENDING:
                raise GateError(
                    "state_conflict",
                    f"cannot confirm a {res.status} reservation",
                    id=id, current_status=res.status,
                )
            res.status = STATUS_CONFIRMED
            return {"status": "confirmed", "id": id, "version": version}

    def cancel(self, *, id: str, version: int, now: float) -> dict:
        with self._lock:
            res = self._get_for_update(id, version)
            if res.status == STATUS_CANCELLED:
                return {"status": "cancelled", "id": id, "version": version,
                        "replayed": True}
            if res.status != STATUS_PENDING:
                raise GateError(
                    "state_conflict",
                    f"cannot cancel a {res.status} reservation",
                    id=id, current_status=res.status,
                )
            res.status = STATUS_CANCELLED
            return {"status": "cancelled", "id": id, "version": version}

    def expire(self, *, id: str, version: int, now: float) -> dict:
        """Fire the timeout timer for one reservation. Versioned: a timer
        armed for an old version is inert against a newer reservation."""
        with self._lock:
            res = self._get_for_update(id, version)
            if res.status == STATUS_EXPIRED:
                return {"status": "expired", "id": id, "version": version,
                        "replayed": True}
            if res.status != STATUS_PENDING:
                raise GateError(
                    "state_conflict",
                    f"cannot expire a {res.status} reservation",
                    id=id, current_status=res.status,
                )
            if now < res.confirm_by:
                raise GateError(
                    "not_due",
                    f"reservation {id!r} is not due until {res.confirm_by}",
                    id=id, confirm_by=res.confirm_by,
                )
            res.status = STATUS_EXPIRED
            return {"status": "expired", "id": id, "version": version}

    def tick(self, *, now: float) -> dict:
        """Expire every due pending reservation, in deterministic
        (confirm_by, id) linearization order."""
        with self._lock:
            due = [r for r in self.state.reservations.values()
                   if r.status == STATUS_PENDING and r.confirm_by <= now]
            due.sort(key=lambda r: (r.confirm_by, r.id))
            expired = []
            for r in due:
                r.status = STATUS_EXPIRED
                expired.append({"id": r.id, "version": r.version})
            return {"status": "ok", "expired": expired}

    # ------------------------------------------------------------------
    # introspection
    # ------------------------------------------------------------------
    def status(self) -> dict:
        with self._lock:
            return {
                "subjects": {s: list(p) for s, p in self.state.subjects.items()},
                "rules": {r: rule.to_dict() for r, rule in self.state.rules.items()},
                "reservations": {
                    i: res.to_dict() for i, res in sorted(self.state.reservations.items())
                },
            }
