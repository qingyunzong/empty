"""Acceptance tests for tenantq.

A: parent-level shortage triggers full-chain rollback
B: retry with the same idempotency key is idempotent
C: confirming a failed reservation raises E_STATE
D: zero quota forbids reservations
E: randomized hierarchy (depth <= 5, <= 1000 ops, failure injection) matches
   an event-sourced reference ledger field by field
Plus: CLI end-to-end flow with JSON output and exit code 2 on PolicyError.
"""

from __future__ import annotations

import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from tenantq import (  # noqa: E402
    CONFIRMED,
    E_CONFIG,
    E_QUOTA,
    E_STATE,
    FAILED,
    PENDING,
    RELEASED,
    Engine,
    PolicyError,
    tenant_chain,
)


class RollbackTest(unittest.TestCase):
    """A: a shortage at any level rolls the whole chain back."""

    def test_parent_shortage_rolls_back_full_chain(self):
        engine = Engine({"root": 6, "root/a": 100, "root/a/b": 100})
        engine.reserve("root/a/b", 4, "k1")
        self.assertEqual(engine.pending, {"root": 4, "root/a": 4, "root/a/b": 4})
        with self.assertRaises(PolicyError) as ctx:
            engine.reserve("root/a/b", 4, "k2")  # root would become 8 > 6
        self.assertEqual(ctx.exception.code, E_QUOTA)
        # every level restored to its pre-operation value
        self.assertEqual(engine.pending, {"root": 4, "root/a": 4, "root/a/b": 4})
        self.assertEqual(engine.used, {"root": 0, "root/a": 0, "root/a/b": 0})
        failed = engine.reservations[ctx.exception.details["reservation_id"]]
        self.assertEqual(failed["state"], FAILED)

    def test_leaf_shortage_rolls_back_full_chain(self):
        engine = Engine({"root": 100, "root/a": 100, "root/a/b": 5})
        engine.reserve("root/a/b", 4, "k1")
        with self.assertRaises(PolicyError) as ctx:
            engine.reserve("root/a/b", 4, "k2")  # leaf would become 8 > 5
        self.assertEqual(ctx.exception.code, E_QUOTA)
        self.assertEqual(engine.pending, {"root": 4, "root/a": 4, "root/a/b": 4})

    def test_confirm_then_release_moves_pending_to_used(self):
        engine = Engine({"root": 10, "root/a": 8})
        out = engine.reserve("root/a", 3, "k1")
        engine.confirm(reservation_id=out["reservation_id"])
        self.assertEqual(engine.pending["root"], 0)
        self.assertEqual(engine.used, {"root": 3, "root/a": 3})
        engine.release(reservation_id=out["reservation_id"])
        self.assertEqual(engine.used, {"root": 0, "root/a": 0})


class IdempotencyTest(unittest.TestCase):
    """B: retrying a successful reserve with the same key replays the result."""

    def test_same_key_returns_original_result_without_recharging(self):
        engine = Engine({"root": 10, "root/a": 5})
        first = engine.reserve("root/a", 3, "key-1")
        second = engine.reserve("root/a", 3, "key-1")
        self.assertEqual(first, second)
        self.assertEqual(engine.pending["root/a"], 3)
        self.assertEqual(engine.pending["root"], 3)
        self.assertEqual(len(engine.reservations), 1)

    def test_failed_key_can_be_retried(self):
        engine = Engine({"root": 4})
        with self.assertRaises(PolicyError):
            engine.reserve("root", 10, "k")
        ok = engine.reserve("root", 2, "k")
        self.assertEqual(ok["state"], PENDING)
        self.assertEqual(engine.pending["root"], 2)


class StateErrorTest(unittest.TestCase):
    """C: confirming a missing or failed reservation raises E_STATE."""

    def test_confirm_failed_reservation_raises_e_state(self):
        engine = Engine({"root": 2})
        with self.assertRaises(PolicyError) as ctx:
            engine.reserve("root", 5, "k1")
        rid = ctx.exception.details["reservation_id"]
        with self.assertRaises(PolicyError) as ctx2:
            engine.confirm(reservation_id=rid)
        self.assertEqual(ctx2.exception.code, E_STATE)
        # state must not silently change
        self.assertEqual(engine.reservations[rid]["state"], FAILED)
        self.assertEqual(engine.pending["root"], 0)
        self.assertEqual(engine.used["root"], 0)

    def test_confirm_unknown_reservation_raises_e_state(self):
        engine = Engine({"root": 2})
        with self.assertRaises(PolicyError) as ctx:
            engine.confirm(key="nope")
        self.assertEqual(ctx.exception.code, E_STATE)
        with self.assertRaises(PolicyError) as ctx:
            engine.confirm(reservation_id="rsv-999")
        self.assertEqual(ctx.exception.code, E_STATE)

    def test_release_requires_confirmed_state(self):
        engine = Engine({"root": 5})
        out = engine.reserve("root", 2, "k1")
        with self.assertRaises(PolicyError) as ctx:
            engine.release(reservation_id=out["reservation_id"])
        self.assertEqual(ctx.exception.code, E_STATE)


class ZeroAndMissingQuotaTest(unittest.TestCase):
    """D: quota 0 forbids; missing quota node is E_CONFIG, not unlimited."""

    def test_zero_quota_rejects(self):
        engine = Engine({"root": 10, "root/a": 0})
        with self.assertRaises(PolicyError) as ctx:
            engine.reserve("root/a", 1, "k1")
        self.assertEqual(ctx.exception.code, E_QUOTA)
        self.assertEqual(engine.pending["root/a"], 0)
        self.assertEqual(engine.pending["root"], 0)

    def test_missing_quota_node_is_e_config(self):
        engine = Engine({"root": 10})
        with self.assertRaises(PolicyError) as ctx:
            engine.reserve("root/ghost", 1, "k1")
        self.assertEqual(ctx.exception.code, E_CONFIG)
        self.assertEqual(len(engine.reservations), 0)


class EventSourcedLedger:
    """Independent reference: state derived purely by folding an event log."""

    def __init__(self, quotas):
        self.quotas = dict(quotas)
        self.events = []
        self.counter = 0

    def _view(self):
        pending = {p: 0 for p in self.quotas}
        used = {p: 0 for p in self.quotas}
        reservations = {}
        key_index = {}
        results = {}
        for ev in self.events:
            kind = ev[0]
            if kind == "reserved":
                _, rid, key, tenant, amount, result = ev
                reservations[rid] = {"id": rid, "key": key, "tenant": tenant,
                                     "amount": amount, "state": PENDING, "released": 0}
                key_index[key] = rid
                results[rid] = result
                for node in tenant_chain(tenant):
                    pending[node] += amount
            elif kind == "reserve_failed":
                _, rid, key, tenant, amount = ev
                reservations[rid] = {"id": rid, "key": key, "tenant": tenant,
                                     "amount": amount, "state": FAILED, "released": 0}
                key_index[key] = rid
            elif kind == "confirmed":
                _, rid = ev
                rec = reservations[rid]
                rec["state"] = CONFIRMED
                for node in tenant_chain(rec["tenant"]):
                    pending[node] -= rec["amount"]
                    used[node] += rec["amount"]
            elif kind == "released":
                _, rid, amount = ev
                rec = reservations[rid]
                rec["released"] += amount
                for node in tenant_chain(rec["tenant"]):
                    used[node] -= amount
                if rec["released"] == rec["amount"]:
                    rec["state"] = RELEASED
        return pending, used, reservations, key_index, results

    def snapshot(self):
        pending, used, reservations, _, _ = self._view()
        return {"pending": pending, "used": used, "reservations": reservations}

    def reserve(self, tenant, amount, key):
        if isinstance(amount, bool) or not isinstance(amount, int) or amount <= 0:
            return ("error", "E_ARGS")
        chain = tenant_chain(tenant)
        pending, used, reservations, key_index, results = self._view()
        existing = key_index.get(key)
        if existing is not None and reservations[existing]["state"] != FAILED:
            return ("ok", dict(results[existing]))
        for node in chain:
            if node not in self.quotas:
                return ("error", E_CONFIG)
        self.counter += 1
        rid = f"rsv-{self.counter}"
        for node in chain:
            if pending[node] + amount + used[node] > self.quotas[node]:
                self.events.append(("reserve_failed", rid, key, tenant, amount))
                return ("error", E_QUOTA)
        result = {"status": "ok", "reservation_id": rid, "idempotency_key": key,
                  "tenant": tenant, "amount": amount, "state": PENDING}
        self.events.append(("reserved", rid, key, tenant, amount, result))
        return ("ok", dict(result))

    def confirm(self, key=None, reservation_id=None):
        if key is None and reservation_id is None:
            return ("error", "E_ARGS")
        _, _, reservations, key_index, _ = self._view()
        rid = reservation_id if reservation_id is not None else key_index.get(key)
        rec = reservations.get(rid) if rid is not None else None
        if rec is None:
            return ("error", E_STATE)
        if rec["state"] in (FAILED, RELEASED):
            return ("error", E_STATE)
        if rec["state"] == PENDING:
            self.events.append(("confirmed", rid))
        return ("ok", {"status": "ok", "reservation_id": rid, "state": CONFIRMED})

    def release(self, key=None, reservation_id=None, amount=None):
        if key is None and reservation_id is None:
            return ("error", "E_ARGS")
        _, _, reservations, key_index, _ = self._view()
        rid = reservation_id if reservation_id is not None else key_index.get(key)
        rec = reservations.get(rid) if rid is not None else None
        if rec is None:
            return ("error", E_STATE)
        if rec["state"] != CONFIRMED:
            return ("error", E_STATE)
        remaining = rec["amount"] - rec["released"]
        if amount is None:
            amount = remaining
        if isinstance(amount, bool) or not isinstance(amount, int) or amount <= 0:
            return ("error", "E_ARGS")
        if amount > remaining:
            return ("error", "E_ARGS")
        self.events.append(("released", rid, amount))
        state = RELEASED if rec["released"] + amount == rec["amount"] else CONFIRMED
        return ("ok", {"status": "ok", "reservation_id": rid,
                       "released": rec["released"] + amount, "state": state})


def run_engine_call(engine, method, **kwargs):
    try:
        return ("ok", getattr(engine, method)(**kwargs))
    except PolicyError as exc:
        return ("error", exc.code)


class RandomizedParityTest(unittest.TestCase):
    """E: random hierarchy/ops with failure injection vs event-sourced ledger."""

    def test_randomized_parity(self):
        rng = random.Random(20261001)
        quotas = {}
        paths = []
        for _ in range(rng.randint(6, 12)):
            parts = []
            for _ in range(rng.randint(1, 5)):  # hierarchy depth <= 5
                parts.append(rng.choice("abcde"))
                path = "/".join(parts)
                if path not in quotas:
                    quotas[path] = rng.choice([0, 0, 3, 8, 15, 30, 60])
                    paths.append(path)
        engine = Engine(quotas)
        ledger = EventSourcedLedger(quotas)
        keys = [f"key-{i}" for i in range(10)]
        bogus_tenants = ["zzz", paths[0] + "/q", paths[-1] + "/x/y"]

        for step in range(1000):
            roll = rng.random()
            if roll < 0.5:
                kwargs = {
                    "tenant": rng.choice(paths + bogus_tenants),
                    "amount": rng.randint(-1, 40),  # failure injection: invalid/huge
                    "key": rng.choice(keys),
                }
                got = run_engine_call(engine, "reserve", **kwargs)
                want = ledger.reserve(**kwargs)
            elif roll < 0.75:
                known = list(ledger.snapshot()["reservations"])
                target = rng.choice(known + ["rsv-9999"]) if known or rng.random() < 0.5 else "rsv-9999"
                if rng.random() < 0.5:
                    kwargs = {"reservation_id": target}
                else:
                    kwargs = {"key": rng.choice(keys + ["ghost-key"])}
                got = run_engine_call(engine, "confirm", **kwargs)
                want = ledger.confirm(**kwargs)
            else:
                known = list(ledger.snapshot()["reservations"])
                target = rng.choice(known + ["rsv-9999"]) if known or rng.random() < 0.5 else "rsv-9999"
                amount = rng.choice([None, None, rng.randint(-1, 40)])
                if rng.random() < 0.5:
                    kwargs = {"reservation_id": target, "amount": amount}
                else:
                    kwargs = {"key": rng.choice(keys + ["ghost-key"]), "amount": amount}
                got = run_engine_call(engine, "release", **kwargs)
                want = ledger.release(**kwargs)

            self.assertEqual(got, want, f"step {step}: {kwargs}")
            self.assertEqual(engine.snapshot(), ledger.snapshot(), f"step {step}: {kwargs}")


class CliTest(unittest.TestCase):
    def _run_cli(self, *args, cwd):
        return subprocess.run(
            [sys.executable, "-m", "tenantq", *args],
            capture_output=True, text=True, cwd=cwd,
        )

    def test_cli_json_flow_and_exit_codes(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = os.path.join(tmp, "cfg.json")
            state = os.path.join(tmp, "state.json")
            with open(config, "w", encoding="utf-8") as fh:
                json.dump({"quotas": {"root": 10, "root/a": 5}}, fh)
            common = ["--config", config, "--state", state]

            r = self._run_cli("reserve", "--tenant", "root/a", "--amount", "3",
                              "--key", "k1", *common, cwd=REPO_ROOT)
            self.assertEqual(r.returncode, 0, r.stderr)
            out = json.loads(r.stdout)
            self.assertEqual(out["status"], "ok")
            self.assertEqual(out["state"], PENDING)
            rid = out["reservation_id"]

            r = self._run_cli("reserve", "--tenant", "root/a", "--amount", "3",
                              "--key", "k1", *common, cwd=REPO_ROOT)
            self.assertEqual(json.loads(r.stdout)["reservation_id"], rid)

            r = self._run_cli("confirm", "--id", rid, *common, cwd=REPO_ROOT)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(json.loads(r.stdout)["state"], CONFIRMED)

            r = self._run_cli("release", "--id", rid, "--amount", "1", *common, cwd=REPO_ROOT)
            self.assertEqual(r.returncode, 0, r.stderr)
            out = json.loads(r.stdout)
            self.assertEqual(out["released"], 1)
            self.assertEqual(out["state"], CONFIRMED)

            r = self._run_cli("release", "--id", rid, *common, cwd=REPO_ROOT)
            self.assertEqual(json.loads(r.stdout)["state"], RELEASED)

            r = self._run_cli("confirm", "--key", "missing", *common, cwd=REPO_ROOT)
            self.assertEqual(r.returncode, 2)
            err = json.loads(r.stdout)
            self.assertEqual(err["status"], "error")
            self.assertEqual(err["error"]["code"], E_STATE)

            r = self._run_cli("reserve", "--tenant", "root/a", "--amount", "9",
                              "--key", "k2", *common, cwd=REPO_ROOT)
            self.assertEqual(r.returncode, 2)
            self.assertEqual(json.loads(r.stdout)["error"]["code"], E_QUOTA)

            r = self._run_cli("status", *common, cwd=REPO_ROOT)
            self.assertEqual(r.returncode, 0, r.stderr)
            out = json.loads(r.stdout)
            self.assertEqual(out["used"], {"root": 0, "root/a": 0})


if __name__ == "__main__":
    unittest.main()
