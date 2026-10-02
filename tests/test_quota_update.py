"""Quota updates: decrease/increase linearized against holds."""
import unittest
from datetime import datetime, timezone

from budget_gate import BudgetGate, WindowSpec

T0 = datetime(2023, 10, 1, 12, 0, tzinfo=timezone.utc).timestamp()
FAR = T0 + 10_000


def make_gate(cap):
    g = BudgetGate()
    g.add_subject("s")
    g.set_quota("s", "r", [WindowSpec(kind="rolling", capacity=cap, seconds=3600)])
    return g


def reserve(g, id, amount):
    return g.reserve(id=id, subject="s", amount=amount, execute_at=T0,
                     confirm_by=FAR, now=T0)


def set_cap(g, cap):
    g.set_quota("s", "r", [WindowSpec(kind="rolling", capacity=cap, seconds=3600)])


class TestQuotaUpdate(unittest.TestCase):
    def test_decrease_grandfathers_existing_holds(self):
        g = make_gate(10)
        reserve(g, "a", 7)
        set_cap(g, 5)
        # Existing hold is untouched but new reserves must fit the new cap.
        self.assertEqual(g.occupancy_report("s", T0)[0]["occupied"], 7)
        r = reserve(g, "b", 1)
        self.assertEqual(r["status"], "rejected")
        self.assertEqual(r["failures"][0]["available"], 0)

    def test_capacity_freed_by_cancel_reusable_up_to_new_cap(self):
        g = make_gate(10)
        reserve(g, "a", 7)
        set_cap(g, 5)
        g.cancel(id="a", version=1, now=T0 + 1)
        self.assertEqual(reserve(g, "b", 5)["status"], "reserved")
        self.assertEqual(reserve(g, "c", 1)["status"], "rejected")

    def test_increase_allows_more(self):
        g = make_gate(3)
        reserve(g, "a", 3)
        self.assertEqual(reserve(g, "b", 1)["status"], "rejected")
        set_cap(g, 4)
        # The recorded rejection is replayed for the identical payload...
        replay = reserve(g, "b", 1)
        self.assertEqual(replay["status"], "rejected")
        self.assertTrue(replay["replayed"])
        # ...while a genuinely new request gets a fresh decision.
        self.assertEqual(reserve(g, "b2", 1)["status"], "reserved")

    def test_decrease_to_zero_blocks_everything(self):
        g = make_gate(5)
        reserve(g, "a", 2)
        set_cap(g, 0)
        self.assertEqual(reserve(g, "b", 1)["status"], "rejected")
        g.cancel(id="a", version=1, now=T0 + 1)
        self.assertEqual(reserve(g, "c", 1)["status"], "rejected")

    def test_rule_ownership_enforced(self):
        from budget_gate import GateError
        g = make_gate(5)
        g.add_subject("other")
        with self.assertRaises(GateError) as ctx:
            g.set_quota("other", "r", [
                WindowSpec(kind="rolling", capacity=1, seconds=60)])
        self.assertEqual(ctx.exception.code, "rule_conflict")


if __name__ == "__main__":
    unittest.main()
