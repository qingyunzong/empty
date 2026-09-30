"""E: randomized hierarchy (depth <= 5) and operation sequences (<= 1000 ops,
including injected failures) checked field-by-field against an independent
event-sourced reference ledger.

The Ledger below is a deliberately separate re-implementation: it appends
events to a log and folds them into state.  After every single operation the
engine's full serialized state (tenants, reservations, idempotency keys,
sequence counter) must deep-equal the ledger's folded state, and every
operation outcome (success payload or error code) must match the ledger's
independently computed expectation.
"""

import copy
import random
import unittest

from tenantq.core import Engine, PolicyError

RESOURCES = ("cpu", "mem", "gpu", "net")  # 'net' is never configured -> E_CONFIG
MAX_DEPTH = 5
MAX_OPS = 1000


class Ledger:
    """Event-sourced reference ledger (independent of tenantq.core)."""

    def __init__(self):
        self.events = []

    # -- event folding ---------------------------------------------------
    def state(self):
        tenants, reservations, keys, seq = {}, {}, {}, 0
        for event in self.events:
            kind = event[0]
            if kind == "add_tenant":
                _, tid, parent = event
                tenants[tid] = {"parent": parent, "quotas": {}, "used": {}, "pending": {}}
            elif kind == "set_quota":
                _, tid, resource, limit = event
                tenants[tid]["quotas"][resource] = limit
            elif kind == "reserve_ok":
                _, rid, tid, resource, amount, key, chain, response = event
                for t in chain:
                    node = tenants[t]
                    node["pending"][resource] = node["pending"].get(resource, 0) + amount
                reservations[rid] = {
                    "id": rid, "tenant": tid, "resource": resource, "amount": amount,
                    "key": key, "state": "pending", "chain": list(chain),
                }
                keys[key] = {
                    "request": {"tenant": tid, "resource": resource, "amount": amount},
                    "response": copy.deepcopy(response),
                }
                seq += 1
            elif kind == "reserve_failed":
                _, rid, tid, resource, amount, key, chain = event
                reservations[rid] = {
                    "id": rid, "tenant": tid, "resource": resource, "amount": amount,
                    "key": key, "state": "failed", "chain": list(chain),
                }
                seq += 1
            elif kind == "confirmed":
                _, rid = event
                rsv = reservations[rid]
                for t in rsv["chain"]:
                    node = tenants[t]
                    node["pending"][rsv["resource"]] -= rsv["amount"]
                    node["used"][rsv["resource"]] = (
                        node["used"].get(rsv["resource"], 0) + rsv["amount"]
                    )
                rsv["state"] = "confirmed"
            elif kind == "released":
                _, rid = event
                rsv = reservations[rid]
                for t in rsv["chain"]:
                    node = tenants[t]
                    node["used"][rsv["resource"]] -= rsv["amount"]
                rsv["state"] = "released"
            else:  # pragma: no cover - defensive
                raise AssertionError(f"unknown event {event!r}")
        return {"tenants": tenants, "reservations": reservations, "keys": keys, "seq": seq}

    # -- independent expectation logic ------------------------------------
    @staticmethod
    def _chain_of(tenants, tid):
        chain = []
        while tid is not None:
            chain.append(tid)
            tid = tenants[tid]["parent"]
        return chain

    def expect_reserve(self, tid, resource, amount, key):
        """Return ('ok', response, event) or ('error', code, event_or_None)."""
        st = self.state()
        if amount <= 0:
            return ("error", "E_ARGS", None)
        if tid not in st["tenants"]:
            return ("error", "E_NOTFOUND", None)
        chain = self._chain_of(st["tenants"], tid)
        cached = st["keys"].get(key)
        if cached is not None:
            request = {"tenant": tid, "resource": resource, "amount": amount}
            if cached["request"] != request:
                return ("error", "E_CONFLICT", None)
            return ("ok", copy.deepcopy(cached["response"]), None)
        rid = f"rsv-{st['seq'] + 1:08d}"
        for t in chain:
            node = st["tenants"][t]
            if resource not in node["quotas"]:
                return ("error", "E_CONFIG",
                        ("reserve_failed", rid, tid, resource, amount, key, chain))
            available = (
                node["quotas"][resource]
                - node["used"].get(resource, 0)
                - node["pending"].get(resource, 0)
            )
            if available < amount:
                return ("error", "E_QUOTA",
                        ("reserve_failed", rid, tid, resource, amount, key, chain))
        response = {
            "ok": True, "reservation_id": rid, "state": "pending", "tenant": tid,
            "resource": resource, "amount": amount, "idempotency_key": key,
        }
        return ("ok", response,
                ("reserve_ok", rid, tid, resource, amount, key, chain, response))

    def expect_transition(self, rid, action):
        """action: 'confirm' or 'release'."""
        st = self.state()
        rsv = st["reservations"].get(rid)
        required = "pending" if action == "confirm" else "confirmed"
        new_state = "confirmed" if action == "confirm" else "released"
        if rsv is None or rsv["state"] != required:
            return ("error", "E_STATE", None)
        response = {
            "ok": True, "reservation_id": rid, "state": new_state,
            "tenant": rsv["tenant"], "resource": rsv["resource"],
            "amount": rsv["amount"], "idempotency_key": rsv["key"],
        }
        event = ("confirmed" if action == "confirm" else "released", rid)
        return ("ok", response, event)


class Driver:
    """Applies operations to both the engine and the ledger and reconciles."""

    def __init__(self, test_case, seed):
        self.tc = test_case
        self.rng = random.Random(seed)
        self.engine = Engine()
        self.ledger = Ledger()
        self.tenants = []
        self.successful_keys = []
        self.op_count = 0

    # -- setup -------------------------------------------------------------
    def build_hierarchy(self, n_tenants):
        depths = {}
        for index in range(n_tenants):
            tid = f"t{index}"
            if index == 0:
                parent = None
                depths[tid] = 1
            else:
                candidates = [t for t in self.tenants if depths[t] < MAX_DEPTH]
                parent = self.rng.choice(candidates)
                depths[tid] = depths[parent] + 1
            self.engine.add_tenant(tid, parent=parent)
            self.ledger.events.append(("add_tenant", tid, parent))
            self.tenants.append(tid)
            for resource in RESOURCES:
                if resource != "net" and self.rng.random() < 0.7:
                    limit = self.rng.randint(0, 20)  # 0 included: forbidden quota
                    self.engine.set_quota(tid, resource, limit)
                    self.ledger.events.append(("set_quota", tid, resource, limit))
        self.reconcile()

    # -- reconciliation ------------------------------------------------------
    def reconcile(self):
        self.tc.assertEqual(
            self.engine.to_dict(),
            self.ledger.state(),
            f"state divergence after {self.op_count} ops",
        )

    # -- operations ----------------------------------------------------------
    def do_reserve(self, tid, resource, amount, key):
        kind, expected, event = self.ledger.expect_reserve(tid, resource, amount, key)
        try:
            actual = self.engine.reserve(tid, resource, amount, key)
        except PolicyError as exc:
            self.tc.assertEqual(kind, "error", f"unexpected error {exc.code}")
            self.tc.assertEqual(exc.code, expected)
            if event is not None:
                self.tc.assertEqual(exc.reservation_id, event[1])
                self.ledger.events.append(event)
        else:
            self.tc.assertEqual(kind, "ok", f"expected error {expected}, got {actual}")
            self.tc.assertEqual(actual, expected)
            if event is not None:
                self.ledger.events.append(event)
                self.successful_keys.append((key, tid, resource, amount))
        self.op_count += 1
        self.reconcile()

    def do_transition(self, rid, action):
        kind, expected, event = self.ledger.expect_transition(rid, action)
        op = self.engine.confirm if action == "confirm" else self.engine.release
        try:
            actual = op(rid)
        except PolicyError as exc:
            self.tc.assertEqual(kind, "error", f"unexpected error {exc.code}")
            self.tc.assertEqual(exc.code, expected)
        else:
            self.tc.assertEqual(kind, "ok", f"expected error {expected}, got {actual}")
            self.tc.assertEqual(actual, expected)
            self.ledger.events.append(event)
        self.op_count += 1
        self.reconcile()

    # -- random op generation (with failure injection) -----------------------
    def random_op(self, step):
        roll = self.rng.random()
        if roll < 0.45:  # reserve (may fail: quota, config, args, notfound)
            tid = self.rng.choice(self.tenants + ["ghost-tenant"])
            resource = self.rng.choice(RESOURCES)
            amount = self.rng.randint(0, 25)  # 0 -> E_ARGS injection
            self.do_reserve(tid, resource, amount, key=f"key-{step}")
        elif roll < 0.60:  # idempotent replay / conflict injection
            if self.successful_keys and self.rng.random() < 0.8:
                key, tid, resource, amount = self.rng.choice(self.successful_keys)
                if self.rng.random() < 0.3:
                    amount += 1  # same key, different payload -> E_CONFLICT
                self.do_reserve(tid, resource, amount, key=key)
            else:
                self.do_reserve(self.rng.choice(self.tenants),
                                self.rng.choice(RESOURCES),
                                self.rng.randint(1, 10), key=f"key-{step}")
        elif roll < 0.85:  # confirm / release some reservation (any state)
            st = self.ledger.state()
            ids = list(st["reservations"]) + ["rsv-99999999", "rsv-bogus"]
            rid = self.rng.choice(ids)
            self.do_transition(rid, self.rng.choice(("confirm", "release")))
        else:  # pure failure injection: bogus ids and unknown tenants
            action = self.rng.random()
            if action < 0.5:
                self.do_transition(f"rsv-{self.rng.randint(0, 10**9)}",
                                   self.rng.choice(("confirm", "release")))
            else:
                self.do_reserve("no-such-tenant", "cpu", 1, key=f"key-{step}")


class TestRandomizedAgainstLedger(unittest.TestCase):
    def run_scenario(self, seed, n_tenants, n_ops):
        driver = Driver(self, seed)
        driver.build_hierarchy(n_tenants)
        # sanity: hierarchy depth is within the required bound
        st = driver.ledger.state()
        for tid in driver.tenants:
            self.assertLessEqual(len(driver.ledger._chain_of(st["tenants"], tid)), MAX_DEPTH)
        for step in range(n_ops):
            driver.random_op(step)
        self.assertLessEqual(driver.op_count, MAX_OPS)
        driver.reconcile()

    def test_seed_1(self):
        self.run_scenario(seed=1, n_tenants=12, n_ops=1000)

    def test_seed_2(self):
        self.run_scenario(seed=2, n_tenants=8, n_ops=1000)

    def test_seed_3(self):
        self.run_scenario(seed=3, n_tenants=16, n_ops=1000)

    def test_seed_4(self):
        self.run_scenario(seed=42, n_tenants=10, n_ops=1000)


if __name__ == "__main__":
    unittest.main()
