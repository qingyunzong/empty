"""Independent reference model used to cross-check the real authorizer.

Deliberately implemented with naive, direct methods (no shared code with
``solver``/``system``): availability is recomputed from scratch, feasible
allocations are found by brute-force enumeration of subsets and integer
compositions, and linearizability is checked by searching serial
histories.  Agreement between :class:`RefModel` and
:class:`budget_auth.system.Authorizer` over enumerated interleavings is
the correctness evidence.
"""
from itertools import combinations


def _compositions(total, parts):
    """Yield all tuples of ``parts`` positive ints summing to ``total``."""
    if parts == 1:
        yield (total,)
        return
    for first in range(1, total - parts + 2):
        for rest in _compositions(total - first, parts - 1):
            yield (first,) + rest


def interleavings(seqs):
    """Yield all order-preserving interleavings of the given sequences."""
    seqs = [s for s in seqs if s]
    if not seqs:
        yield []
        return
    for i, seq in enumerate(seqs):
        for rest in interleavings(seqs[:i] + [seq[1:]] + seqs[i + 1:]):
            yield [seq[0]] + rest


class RefModel:
    def __init__(self):
        self.budgets = {}        # id -> {"quota": int, "parent": id|None}
        self.rules = {}          # id -> dict
        self.reservations = {}   # id -> dict
        self.now = 0

    # ------------------------------------------------------- primitives
    def _is_ancestor(self, ancestor, bid):
        cur = bid
        while cur is not None:
            if cur == ancestor:
                return True
            cur = self.budgets[cur]["parent"]
        return False

    def _available(self, bid):
        used = 0
        for reservation in self.reservations.values():
            if reservation["status"] in ("active", "confirmed"):
                for held_budget, amount in reservation["holds"].items():
                    if self._is_ancestor(bid, held_budget):
                        used += amount
        return max(0, self.budgets[bid]["quota"] - used)

    def _feasible(self, alloc):
        for bid in self.budgets:
            total = sum(amount for held, amount in alloc.items()
                        if self._is_ancestor(bid, held))
            if total > self._available(bid):
                return False
        return True

    def all_allocations(self, candidates, amount):
        """Brute-force: every feasible hold dict over the candidates."""
        out = []
        ids = sorted(set(candidates))
        for size in range(1, len(ids) + 1):
            for subset in combinations(ids, size):
                for split in _compositions(amount, size):
                    alloc = dict(zip(subset, split))
                    if self._feasible(alloc):
                        out.append(alloc)
        return out

    def _canonical_split(self, subset, amount):
        alloc = {}
        remaining = amount
        for bid in sorted(subset):
            best = 0
            for take in range(remaining, 0, -1):
                trial = dict(alloc)
                trial[bid] = take
                if self._feasible(trial):
                    best = take
                    break
            if best:
                alloc[bid] = best
                remaining -= best
            if remaining == 0:
                return alloc
        return alloc if remaining == 0 else None

    def best_allocation(self, candidates, amount):
        ids = sorted(set(candidates))
        for size in range(1, len(ids) + 1):
            for subset in combinations(ids, size):
                alloc = self._canonical_split(subset, amount)
                if alloc is not None:
                    return alloc
        return None

    # ------------------------------------------------------------- ops
    def apply(self, op):
        op = dict(op)
        now = op.get("now")
        if now is not None:
            if not isinstance(now, int) or now < self.now:
                return {"ok": False, "error": "clock_regression",
                        "now": self.now}
            self.now = now
        for reservation in self.reservations.values():
            if (reservation["status"] == "active"
                    and reservation["expires_at"] < self.now):
                reservation["status"] = "expired"
        return getattr(self, "_op_" + op["op"])(op)

    def _op_tick(self, op):
        return {"ok": True, "now": self.now}

    def _op_add_budget(self, op):
        if op["id"] in self.budgets:
            return {"ok": False, "error": "duplicate_budget"}
        self.budgets[op["id"]] = {"quota": op["quota"],
                                  "parent": op.get("parent")}
        return {"ok": True, "budget": op["id"]}

    def _op_add_rule(self, op):
        self.rules[op["id"]] = {
            "subject": op["subject"], "resource": op["resource"],
            "budget": op["budget"], "start": op["start"], "end": op["end"],
        }
        return {"ok": True, "rule": op["id"]}

    def _op_set_quota(self, op):
        self.budgets[op["budget"]]["quota"] = op["quota"]
        return {"ok": True, "budget": op["budget"], "quota": op["quota"]}

    def _op_reserve(self, op):
        rid = op["request"]
        if rid in self.reservations:
            return {"ok": False, "error": "duplicate_request"}
        amount = op["amount"]
        if not isinstance(amount, int) or amount <= 0:
            return {"ok": False, "error": "invalid_amount"}
        candidates = sorted({
            rule["budget"] for rule in self.rules.values()
            if rule["budget"] in self.budgets
            and rule["subject"] in ("*", op["subject"])
            and rule["resource"] in ("*", op["resource"])
            and rule["start"] <= self.now <= rule["end"]})
        if not candidates:
            return {"ok": False, "error": "no_matching_rule"}
        holds = self.best_allocation(candidates, amount)
        if holds is None:
            return {"ok": False, "error": "insufficient_capacity"}
        expires_at = self.now + op.get("ttl", 0)
        self.reservations[rid] = {
            "subject": op["subject"], "resource": op["resource"],
            "amount": amount, "holds": dict(sorted(holds.items())),
            "expires_at": expires_at, "status": "active",
        }
        return {"ok": True, "request": rid,
                "holds": dict(sorted(holds.items())),
                "expires_at": expires_at}

    def _op_confirm(self, op):
        reservation = self.reservations.get(op["request"])
        if reservation is None:
            return {"ok": False, "error": "unknown_request"}
        if reservation["status"] != "active":
            return {"ok": False, "error": "invalid_status",
                    "status": reservation["status"]}
        reservation["status"] = "confirmed"
        return {"ok": True, "request": op["request"], "status": "confirmed"}

    def _op_release(self, op):
        reservation = self.reservations.get(op["request"])
        if reservation is None:
            return {"ok": False, "error": "unknown_request"}
        if reservation["status"] != "active":
            return {"ok": False, "error": "invalid_status",
                    "status": reservation["status"]}
        reservation["status"] = "released"
        return {"ok": True, "request": op["request"], "status": "released"}

    def snapshot(self):
        return {
            "now": self.now,
            "budgets": {bid: {"quota": b["quota"], "parent": b["parent"]}
                        for bid, b in sorted(self.budgets.items())},
            "rules": {rid: dict(rule) for rid, rule
                      in sorted(self.rules.items())},
            "reservations": {rid: dict(res) for rid, res
                             in sorted(self.reservations.items())},
        }


def find_serial_history(setup_ops, tagged_threads, expected_ok):
    """Search a serial history explaining the observed accept/reject vector.

    ``tagged_threads`` is a list of per-thread lists of ``(tag, op)``;
    ``expected_ok`` maps each tag to the observed boolean outcome.
    Returns one explaining serial op list, or None if the concurrent
    history is not linearizable.
    """
    for interleaving in interleavings(tagged_threads):
        model = RefModel()
        for op in setup_ops:
            model.apply(op)
        if all(model.apply(op)["ok"] == expected_ok[tag]
               for tag, op in interleaving):
            return [op for _, op in interleaving]
    return None
