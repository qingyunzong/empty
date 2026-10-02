"""Idempotent replay of reserves, rejections, and state persistence."""
import unittest
from datetime import datetime, timezone

from budget_gate import BudgetGate, GateError, GateState, WindowSpec
from budget_gate import store

T0 = datetime(2023, 10, 1, 12, 0, tzinfo=timezone.utc).timestamp()
FAR = T0 + 10_000


def make_gate(cap=5):
    g = BudgetGate()
    g.add_subject("s")
    g.set_quota("s", "r", [WindowSpec(kind="rolling", capacity=cap, seconds=3600)])
    return g


def reserve(g, id="q", amount=3, execute_at=T0, now=T0):
    return g.reserve(id=id, subject="s", amount=amount, execute_at=execute_at,
                     confirm_by=FAR, now=now)


class TestReserveReplay(unittest.TestCase):
    def test_replayed_reserve_charges_once(self):
        g = make_gate()
        r1 = reserve(g)
        r2 = reserve(g)
        self.assertEqual(r1["status"], "reserved")
        self.assertEqual(r2["status"], "reserved")
        self.assertTrue(r2["replayed"])
        self.assertEqual(r1["version"], r2["version"])
        self.assertEqual(g.occupancy_report("s", T0)[0]["occupied"], 3)

    def test_replay_after_deadline_passed_still_returns_recorded_result(self):
        g = make_gate()
        reserve(g, now=T0)
        # Time has moved past confirm_by; a naive re-validation would fail.
        r = g.reserve(id="q", subject="s", amount=3, execute_at=T0,
                      confirm_by=FAR, now=FAR + 1)
        self.assertEqual(r["status"], "reserved")
        self.assertTrue(r["replayed"])

    def test_rejected_reserve_replays_same_rejection(self):
        g = make_gate(cap=2)
        r1 = reserve(g, amount=3)
        self.assertEqual(r1["status"], "rejected")
        r2 = reserve(g, amount=3)
        self.assertEqual(r2["status"], "rejected")
        self.assertTrue(r2["replayed"])
        self.assertEqual(r1["failures"], r2["failures"])

    def test_new_request_after_rejection_is_allowed(self):
        g = make_gate(cap=2)
        reserve(g, amount=3)  # rejected, nothing held
        r = reserve(g, amount=2)
        self.assertEqual(r["status"], "reserved")
        self.assertEqual(r["version"], 1)


class TestStateRoundTrip(unittest.TestCase):
    def test_state_survives_serialization(self):
        g = make_gate()
        reserve(g, "a")
        reserve(g, "b", amount=2)
        g.cancel(id="b", version=1, now=T0 + 1)
        blob = GateState.from_dict(g.state.to_dict())
        g2 = BudgetGate(blob)
        self.assertEqual(g2.occupancy_report("s", T0)[0]["occupied"], 3)
        # Replay still works after a restart.
        r = reserve(g2, "a")
        self.assertTrue(r["replayed"])
        with self.assertRaises(GateError) as ctx:
            reserve(g2, "a", amount=1)
        self.assertEqual(ctx.exception.code, "id_conflict")

    def test_store_round_trip(self):
        import os, tempfile
        g = make_gate()
        reserve(g, "a")
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "state.json")
            store.save_state(g.state, path)
            g2 = BudgetGate(store.load_state(path))
            self.assertEqual(g2.occupancy_report("s", T0)[0]["occupied"], 3)
            # Loading a missing path yields a fresh state.
            fresh = store.load_state(os.path.join(d, "missing.json"))
            self.assertEqual(fresh.subjects, {})


if __name__ == "__main__":
    unittest.main()
