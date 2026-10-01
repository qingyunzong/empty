"""Budget authorizer: nested scopes, phased reservations, persistent log.

Semantics
---------
* Rules map (subject, resource, time window) conditions to a budget.
  ``"*"`` matches any subject/resource; windows are inclusive.
* A reservation goes through phases: active -> confirmed | released.
  A reservation whose ``expires_at < now`` is expired lazily at the next
  linearization point (any incoming operation advances the clock first).
  A confirm at exactly ``now == expires_at`` is still valid.
* Active and confirmed holds both consume quota; released/expired holds
  free it.  Confirm only flips the status, so the deduction is a pure
  function of the holds and can never be applied twice, even when the
  log is replayed.
* Every accepted, state-changing operation is appended to a JSONL log
  (flush + fsync) after it is applied.  A clock advance is logged as a
  ``tick`` record even when the triggering operation itself is rejected,
  so replay always reproduces the same expirations.  Recovery replays
  the log from any consistent prefix.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass

from . import solver

COUNTED_STATUSES = ("active", "confirmed")
# ``tick`` is absent: a clock advance is already persisted as a ``tick``
# record before the triggering op runs, so logging the op itself would
# write the same record twice.
LOGGED_OPS = ("add_budget", "add_rule", "set_quota",
              "reserve", "confirm", "release")


@dataclass
class Budget:
    id: str
    quota: int
    parent: str | None = None


@dataclass
class Rule:
    id: str
    subject: str
    resource: str
    budget: str
    start: int
    end: int

    def matches(self, subject, resource, now):
        return (self.subject in ("*", subject)
                and self.resource in ("*", resource)
                and self.start <= now <= self.end)


@dataclass
class Reservation:
    id: str
    subject: str
    resource: str
    amount: int
    holds: dict
    expires_at: int
    status: str = "active"  # active | confirmed | released | expired


class Authorizer:
    def __init__(self, log_path=None):
        self.budgets: dict[str, Budget] = {}
        self.rules: dict[str, Rule] = {}
        self.reservations: dict[str, Reservation] = {}
        self.now = 0
        self.log_path = log_path
        self._log_fp = (open(log_path, "a", encoding="utf-8")
                        if log_path else None)

    # ---------------------------------------------------------- recovery
    @classmethod
    def recover(cls, log_path):
        """Rebuild an authorizer by replaying the persistent log."""
        auth = cls(log_path=log_path)
        if os.path.exists(log_path):
            with open(log_path, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if line:
                        auth._apply(json.loads(line), replay=True)
        return auth

    def close(self):
        if self._log_fp:
            self._log_fp.close()
            self._log_fp = None

    # ------------------------------------------------------------- ops
    def apply(self, op):
        """Apply one operation; this is its linearization point."""
        return self._apply(dict(op), replay=False)

    def _apply(self, op, replay):
        kind = op.get("op")
        handler = getattr(self, "_op_" + str(kind), None)
        if handler is None:
            return {"ok": False, "error": "unknown_op", "op": kind}
        now = op.get("now")
        if now is not None:
            if not isinstance(now, int) or now < self.now:
                return {"ok": False, "error": "clock_regression",
                        "now": self.now}
            if now > self.now:
                self.now = now
                self._expire_due()
                if not replay:
                    self._write_log({"op": "tick", "now": now})
        result = handler(op)
        if result["ok"] and not replay and kind in LOGGED_OPS:
            self._write_log(op)
        return result

    def _expire_due(self):
        for reservation in self.reservations.values():
            if (reservation.status == "active"
                    and reservation.expires_at < self.now):
                reservation.status = "expired"

    def _write_log(self, record):
        if self._log_fp:
            self._log_fp.write(json.dumps(record, sort_keys=True) + "\n")
            self._log_fp.flush()
            os.fsync(self._log_fp.fileno())

    # ------------------------------------------------------- op handlers
    def _op_tick(self, op):
        return {"ok": True, "now": self.now}

    def _op_add_budget(self, op):
        bid = op.get("id")
        quota = op.get("quota")
        parent = op.get("parent")
        if bid in self.budgets:
            return {"ok": False, "error": "duplicate_budget", "budget": bid}
        if not isinstance(quota, int) or quota < 0:
            return {"ok": False, "error": "invalid_quota", "quota": quota}
        if parent is not None and parent not in self.budgets:
            return {"ok": False, "error": "unknown_parent", "parent": parent}
        self.budgets[bid] = Budget(bid, quota, parent)
        return {"ok": True, "budget": bid}

    def _op_add_rule(self, op):
        rid = op.get("id")
        if rid in self.rules:
            return {"ok": False, "error": "duplicate_rule", "rule": rid}
        if op.get("budget") not in self.budgets:
            return {"ok": False, "error": "unknown_budget",
                    "budget": op.get("budget")}
        self.rules[rid] = Rule(rid, op["subject"], op["resource"],
                               op["budget"], op["start"], op["end"])
        return {"ok": True, "rule": rid}

    def _op_set_quota(self, op):
        budget = self.budgets.get(op.get("budget"))
        if budget is None:
            return {"ok": False, "error": "unknown_budget",
                    "budget": op.get("budget")}
        quota = op.get("quota")
        if not isinstance(quota, int) or quota < 0:
            return {"ok": False, "error": "invalid_quota", "quota": quota}
        budget.quota = quota
        return {"ok": True, "budget": budget.id, "quota": quota}

    def _op_reserve(self, op):
        rid = op.get("request")
        if rid in self.reservations:
            return {"ok": False, "error": "duplicate_request", "request": rid}
        amount = op.get("amount")
        if not isinstance(amount, int) or amount <= 0:
            return {"ok": False, "error": "invalid_amount", "amount": amount}
        ttl = op.get("ttl", 0)
        if not isinstance(ttl, int) or ttl < 0:
            return {"ok": False, "error": "invalid_ttl", "ttl": ttl}
        candidates = self._candidates(op.get("subject"), op.get("resource"))
        if not candidates:
            return {"ok": False, "error": "no_matching_rule",
                    "subject": op.get("subject"),
                    "resource": op.get("resource")}
        used = self._used()
        holds = solver.allocate(self.budgets, used, candidates, amount)
        if holds is None:
            result = {"ok": False, "error": "insufficient_capacity",
                      "request": rid}
            result["unsat"] = solver.diagnose(self.budgets, used,
                                              candidates, amount)
            return result
        expires_at = self.now + ttl
        self.reservations[rid] = Reservation(
            rid, op.get("subject"), op.get("resource"), amount,
            holds, expires_at)
        return {"ok": True, "request": rid, "holds": dict(sorted(holds.items())),
                "expires_at": expires_at}

    def _op_confirm(self, op):
        reservation = self.reservations.get(op.get("request"))
        if reservation is None:
            return {"ok": False, "error": "unknown_request",
                    "request": op.get("request")}
        if reservation.status != "active":
            return {"ok": False, "error": "invalid_status",
                    "request": reservation.id, "status": reservation.status}
        reservation.status = "confirmed"
        return {"ok": True, "request": reservation.id, "status": "confirmed"}

    def _op_release(self, op):
        reservation = self.reservations.get(op.get("request"))
        if reservation is None:
            return {"ok": False, "error": "unknown_request",
                    "request": op.get("request")}
        if reservation.status != "active":
            return {"ok": False, "error": "invalid_status",
                    "request": reservation.id, "status": reservation.status}
        reservation.status = "released"
        return {"ok": True, "request": reservation.id, "status": "released"}

    def _op_snapshot(self, op):
        return {"ok": True, "state": self.snapshot()}

    # ------------------------------------------------------------ views
    def _candidates(self, subject, resource):
        """Budget ids usable for this request, each counted once."""
        return sorted({rule.budget for rule in self.rules.values()
                       if rule.budget in self.budgets
                       and rule.matches(subject, resource, self.now)})

    def _used(self):
        return solver.compute_used(
            self.budgets,
            [r.holds for r in self.reservations.values()
             if r.status in COUNTED_STATUSES])

    def snapshot(self):
        return {
            "now": self.now,
            "budgets": {bid: {"quota": b.quota, "parent": b.parent}
                        for bid, b in sorted(self.budgets.items())},
            "rules": {rid: {"subject": r.subject, "resource": r.resource,
                            "budget": r.budget, "start": r.start, "end": r.end}
                      for rid, r in sorted(self.rules.items())},
            "reservations": {
                rid: {"subject": r.subject, "resource": r.resource,
                      "amount": r.amount, "holds": dict(sorted(r.holds.items())),
                      "expires_at": r.expires_at, "status": r.status}
                for rid, r in sorted(self.reservations.items())},
        }
