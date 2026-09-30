"""The budget authorizer: staged reserve / confirm / release over nested,
shareable budgets, with a write-ahead log for crash recovery.

Concurrency model: every public operation is atomic (its linearization
point is the moment it mutates state, after its WAL record is durable).
Explicit interleavings of these operations are simulated and checked in
`budget_auth.interleave`.
"""

from __future__ import annotations

import copy
from math import inf

from . import solver
from .model import (Budget, Rule, Reservation, ancestor_chain,
                    PENDING, CONFIRMED, RELEASED, EXPIRED)
from .wal import WriteAheadLog, replay

INF = inf


def _err(code: str, message: str, **numbers) -> dict:
    return {"ok": False, "error": {"code": code, "message": message,
                                   **numbers}}


class Authorizer:
    def __init__(self, log_path: str | None = None, now: int = 0):
        self.now = now
        self.budgets: dict[str, Budget] = {}
        self.rules: dict[str, Rule] = {}
        self.reservations: dict[str, Reservation] = {}
        self.held: dict[str, int] = {}
        self._seq = 0
        self._wal = WriteAheadLog(log_path) if log_path else None

    # ------------------------------------------------------------------
    # recovery
    # ------------------------------------------------------------------
    @classmethod
    def recover(cls, log_path: str) -> "Authorizer":
        auth = cls()
        for record in replay(log_path):
            auth._apply_record(record)
            auth._seq = max(auth._seq, record["seq"])
        auth._wal = WriteAheadLog(log_path)
        return auth

    def _apply_record(self, record: dict) -> None:
        """Re-apply a committed record during replay.  Each record is a
        deterministic state transition keyed by its sequence number, so a
        deduction is applied exactly once."""
        op, params, result = record["op"], record["params"], record["result"]
        if op == "add_budget":
            self.budgets[params["id"]] = Budget(params["id"], params["quota"],
                                                params.get("parent"))
            self.held.setdefault(params["id"], 0)
        elif op == "add_rule":
            p = params
            self.rules[p["id"]] = Rule(p["id"], p["subject"], p["resource"],
                                       p["start"], p["end"], p["budget"],
                                       p.get("limit"))
        elif op == "set_quota":
            self.budgets[params["id"]].quota = params["quota"]
        elif op == "reserve":
            r = result
            res = Reservation(r["request_id"], r["subject"], r["resource"],
                              r["amount"], r["allocation"], r["rule_charges"],
                              r["expiry"], PENDING, r["created"])
            self.reservations[res.id] = res
            self._apply_holds(res.allocation, +1)
            for rid, amt in res.rule_charges.items():
                self.rules[rid].used += amt
        elif op == "confirm":
            res = self.reservations[params["request_id"]]
            assert res.status == PENDING, "confirm replayed on non-pending"
            res.status = CONFIRMED
        elif op == "release":
            res = self.reservations[params["request_id"]]
            res.status = RELEASED
            self._apply_holds(res.allocation, -1)
            self._refund_rules(res)
        elif op == "advance_time":
            self.now = result["now"]
            for rid in result["expired"]:
                res = self.reservations[rid]
                res.status = EXPIRED
                self._apply_holds(res.allocation, -1)
                self._refund_rules(res)
        else:  # pragma: no cover - defensive
            raise ValueError(f"unknown log op {op!r}")

    # ------------------------------------------------------------------
    # logging helper
    # ------------------------------------------------------------------
    def _commit(self, op: str, params: dict, result: dict) -> None:
        """WAL first (linearization point of durability), then apply."""
        self._seq += 1
        record = {"seq": self._seq, "op": op, "params": params,
                  "result": result}
        if self._wal:
            self._wal.append(record)
        self._apply_record(record)

    # ------------------------------------------------------------------
    # internal accounting
    # ------------------------------------------------------------------
    def _apply_holds(self, allocation: dict[str, int], sign: int) -> None:
        for bid, amt in allocation.items():
            for node in ancestor_chain(self.budgets, bid):
                self.held[node] = self.held.get(node, 0) + sign * amt

    def _refund_rules(self, res: Reservation) -> None:
        for rid, amt in res.rule_charges.items():
            self.rules[rid].used -= amt

    def _matching_rules(self, subject: str, resource: str) -> list[Rule]:
        return sorted(
            (r for r in self.rules.values()
             if r.matches(subject, resource, self.now)),
            key=lambda r: r.id)

    def _caps(self, rules: list[Rule]) -> dict[str, int | float]:
        caps: dict[str, int | float] = {}
        for rule in rules:
            remaining = INF if rule.limit is None else rule.limit - rule.used
            prev = caps.get(rule.budget, 0)
            if prev is not INF:
                caps[rule.budget] = INF if remaining is INF else prev + remaining
        return caps

    def _charge_rules(self, rules: list[Rule], bid: str,
                      amount: int) -> dict[str, int]:
        charges: dict[str, int] = {}
        left = amount
        for rule in rules:
            if rule.budget != bid or left == 0:
                continue
            take = left if rule.limit is None else min(left,
                                                       rule.limit - rule.used)
            if take > 0:
                charges[rule.id] = take
                left -= take
        return charges

    # ------------------------------------------------------------------
    # schema operations
    # ------------------------------------------------------------------
    def add_budget(self, budget_id: str, quota: int,
                   parent: str | None = None) -> dict:
        if budget_id in self.budgets:
            return _err("duplicate_budget", f"budget {budget_id!r} exists")
        if quota < 0:
            return _err("invalid_quota", "quota must be >= 0", quota=quota)
        if parent is not None and parent not in self.budgets:
            return _err("unknown_parent", f"parent {parent!r} unknown")
        params = {"id": budget_id, "quota": quota, "parent": parent}
        self._commit("add_budget", params, {"ok": True})
        return {"ok": True}

    def add_rule(self, rule_id: str, subject: str, resource: str,
                 start: int, end: int, budget: str,
                 limit: int | None = None) -> dict:
        if rule_id in self.rules:
            return _err("duplicate_rule", f"rule {rule_id!r} exists")
        if budget not in self.budgets:
            return _err("unknown_budget", f"budget {budget!r} unknown")
        if end <= start:
            return _err("invalid_window", "window end must exceed start")
        params = {"id": rule_id, "subject": subject, "resource": resource,
                  "start": start, "end": end, "budget": budget,
                  "limit": limit}
        self._commit("add_rule", params, {"ok": True})
        return {"ok": True}

    def set_quota(self, budget_id: str, quota: int) -> dict:
        if budget_id not in self.budgets:
            return _err("unknown_budget", f"budget {budget_id!r} unknown")
        held = self.held.get(budget_id, 0)
        if quota < held:
            return _err(
                "quota_conflict",
                "quota decrease conflicts with outstanding holds "
                "(reserved or confirmed)",
                budget=budget_id, requested=quota, held=held,
                quota=self.budgets[budget_id].quota)
        self._commit("set_quota", {"id": budget_id, "quota": quota},
                     {"ok": True})
        return {"ok": True}

    # ------------------------------------------------------------------
    # reservation lifecycle
    # ------------------------------------------------------------------
    def reserve(self, request_id: str, subject: str, resource: str,
                amount: int, ttl: int) -> dict:
        if request_id in self.reservations:
            return _err("duplicate_request",
                        f"request {request_id!r} already reserved")
        if not isinstance(amount, int) or amount <= 0:
            return _err("invalid_amount", "amount must be a positive int")
        rules = self._matching_rules(subject, resource)
        if not rules:
            return _err("no_matching_rule",
                        "no rule authorizes this subject/resource now",
                        subject=subject, resource=resource, now=self.now)
        caps = self._caps(rules)
        problem = solver.build_problem(self.budgets, self.held, caps)
        try:
            allocation = problem.solve(amount)
        except solver.AllocationRejected as rej:
            return {"ok": False,
                    "error": {"code": "insufficient_budget",
                              "message": rej.reason,
                              "amount": amount},
                    "unsat_core": rej.core.as_dict()}
        # charge rule limits deterministically (rule id order)
        rule_charges: dict[str, int] = {}
        for bid in sorted(allocation):
            rule_charges.update(self._charge_rules(rules, bid,
                                                   allocation[bid]))
        result = {"request_id": request_id, "subject": subject,
                  "resource": resource, "amount": amount,
                  "allocation": allocation, "rule_charges": rule_charges,
                  "expiry": self.now + ttl, "created": self.now}
        self._commit("reserve", {"request_id": request_id}, result)
        return {"ok": True, "reservation": {**result, "status": PENDING}}

    def confirm(self, request_id: str) -> dict:
        res = self.reservations.get(request_id)
        if res is None:
            return _err("unknown_request", f"request {request_id!r} unknown")
        if res.status == CONFIRMED:
            return _err("duplicate_confirm",
                        "request already confirmed; deduction happens once",
                        request_id=request_id)
        if res.status == EXPIRED or self.now >= res.expiry:
            # Late confirm of an expired reservation: rejected.  Nothing is
            # released here -- expiry already freed exactly this
            # reservation's holds; touching them again would free quota
            # that may have been re-reserved by someone else.
            return _err("expired",
                        "reservation expired before confirm linearized",
                        request_id=request_id, expiry=res.expiry,
                        now=self.now)
        if res.status != PENDING:
            return _err("not_pending",
                        f"request is {res.status}, cannot confirm",
                        request_id=request_id)
        self._commit("confirm", {"request_id": request_id}, {"ok": True})
        return {"ok": True, "confirmed": request_id}

    def release(self, request_id: str) -> dict:
        res = self.reservations.get(request_id)
        if res is None:
            return _err("unknown_request", f"request {request_id!r} unknown")
        if res.status != PENDING:
            return _err("not_pending",
                        f"only pending reservations can be released "
                        f"(status is {res.status})",
                        request_id=request_id)
        self._commit("release", {"request_id": request_id}, {"ok": True})
        return {"ok": True, "released": request_id}

    def advance_time(self, now: int) -> dict:
        if now < self.now:
            return _err("time_regress", "time cannot move backwards",
                        now=self.now, requested=now)
        expiring = sorted(
            (r for r in self.reservations.values()
             if r.status == PENDING and r.expiry <= now),
            key=lambda r: (r.expiry, r.id))
        result = {"now": now, "expired": [r.id for r in expiring]}
        self._commit("advance_time", {"now": now}, result)
        return {"ok": True, **result}

    # ------------------------------------------------------------------
    # inspection
    # ------------------------------------------------------------------
    def state(self) -> dict:
        return {
            "now": self.now,
            "budgets": {bid: {"quota": b.quota, "parent": b.parent,
                              "held": self.held.get(bid, 0)}
                        for bid, b in sorted(self.budgets.items())},
            "rules": {rid: {"used": r.used, "limit": r.limit}
                      for rid, r in sorted(self.rules.items())},
            "reservations": {rid: {"status": r.status, "amount": r.amount,
                                   "allocation": r.allocation,
                                   "expiry": r.expiry}
                             for rid, r in sorted(self.reservations.items())},
        }

    def check_invariants(self) -> None:
        """Held amounts never exceed quota and always equal the sum of
        live reservations' attributed allocations."""
        expect: dict[str, int] = {bid: 0 for bid in self.budgets}
        for res in self.reservations.values():
            if res.status in (PENDING, CONFIRMED):
                for bid, amt in res.allocation.items():
                    for node in ancestor_chain(self.budgets, bid):
                        expect[node] += amt
        assert expect == {b: self.held.get(b, 0) for b in self.budgets}, \
            f"held mismatch: {expect} vs {self.held}"
        for bid, b in self.budgets.items():
            assert self.held.get(bid, 0) <= b.quota, \
                f"budget {bid} over quota: {self.held[bid]} > {b.quota}"

    # ------------------------------------------------------------------
    # snapshot / restore for interleaving search
    # ------------------------------------------------------------------
    def snapshot(self) -> dict:
        return {"now": self.now, "seq": self._seq,
                "budgets": copy.deepcopy(self.budgets),
                "rules": copy.deepcopy(self.rules),
                "reservations": copy.deepcopy(self.reservations),
                "held": dict(self.held)}

    def restore(self, snap: dict) -> None:
        self.now, self._seq = snap["now"], snap["seq"]
        self.budgets, self.rules = snap["budgets"], snap["rules"]
        self.reservations, self.held = snap["reservations"], snap["held"]

    def close(self) -> None:
        if self._wal:
            self._wal.close()
