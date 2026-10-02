"""Reservation lifecycle: confirm / cancel / expire / tick, versioned
timers, late cancels, id reuse after terminal states."""
import unittest
from datetime import datetime, timezone

from budget_gate import BudgetGate, GateError, WindowSpec

T0 = datetime(2023, 10, 1, 12, 0, tzinfo=timezone.utc).timestamp()
DEADLINE = T0 + 600


def make_gate(capacity=5):
    g = BudgetGate()
    g.add_subject("s")
    g.set_quota("s", "r", [WindowSpec(kind="rolling", capacity=capacity, seconds=3600)])
    return g


def reserve(g, id="q", amount=3, execute_at=T0, confirm_by=DEADLINE, now=T0):
    return g.reserve(id=id, subject="s", amount=amount, execute_at=execute_at,
                     confirm_by=confirm_by, now=now)


def occupied(g, at=T0):
    return g.occupancy_report("s", at)[0]["occupied"]


class TestConfirmCancel(unittest.TestCase):
    def test_confirm_keeps_occupancy(self):
        g = make_gate()
        reserve(g)
        r = g.confirm(id="q", version=1, now=T0 + 1)
        self.assertEqual(r["status"], "confirmed")
        self.assertEqual(occupied(g), 3)

    def test_confirm_is_idempotent(self):
        g = make_gate()
        reserve(g)
        g.confirm(id="q", version=1, now=T0 + 1)
        r = g.confirm(id="q", version=1, now=T0 + 2)
        self.assertEqual(r["status"], "confirmed")
        self.assertTrue(r["replayed"])

    def test_cancel_releases_and_is_idempotent(self):
        g = make_gate()
        reserve(g)
        g.cancel(id="q", version=1, now=T0 + 1)
        self.assertEqual(occupied(g), 0)
        r = g.cancel(id="q", version=1, now=T0 + 2)
        self.assertEqual(r["status"], "cancelled")
        self.assertTrue(r["replayed"])

    def test_cancel_after_confirm_rejected(self):
        g = make_gate()
        reserve(g)
        g.confirm(id="q", version=1, now=T0 + 1)
        with self.assertRaises(GateError) as ctx:
            g.cancel(id="q", version=1, now=T0 + 2)
        self.assertEqual(ctx.exception.code, "state_conflict")
        self.assertEqual(occupied(g), 3)

    def test_unknown_id_and_stale_version(self):
        g = make_gate()
        reserve(g)
        with self.assertRaises(GateError) as ctx:
            g.confirm(id="nope", version=1, now=T0)
        self.assertEqual(ctx.exception.code, "unknown_id")
        with self.assertRaises(GateError) as ctx:
            g.confirm(id="q", version=99, now=T0)
        self.assertEqual(ctx.exception.code, "stale_version")


class TestExpiryTimers(unittest.TestCase):
    def test_expire_releases_capacity(self):
        g = make_gate()
        reserve(g)
        r = g.expire(id="q", version=1, now=DEADLINE)
        self.assertEqual(r["status"], "expired")
        self.assertEqual(occupied(g), 0)

    def test_expire_before_deadline_rejected(self):
        g = make_gate()
        reserve(g)
        with self.assertRaises(GateError) as ctx:
            g.expire(id="q", version=1, now=DEADLINE - 1)
        self.assertEqual(ctx.exception.code, "not_due")
        self.assertEqual(occupied(g), 3)

    def test_expire_is_idempotent(self):
        g = make_gate()
        reserve(g)
        g.expire(id="q", version=1, now=DEADLINE)
        r = g.expire(id="q", version=1, now=DEADLINE + 10)
        self.assertEqual(r["status"], "expired")
        self.assertTrue(r["replayed"])

    def test_late_confirm_after_expiry_rejected(self):
        g = make_gate()
        reserve(g)
        g.expire(id="q", version=1, now=DEADLINE)
        with self.assertRaises(GateError) as ctx:
            g.confirm(id="q", version=1, now=DEADLINE + 1)
        self.assertEqual(ctx.exception.code, "state_conflict")

    def test_late_cancel_after_expiry_releases_nothing(self):
        g = make_gate()
        reserve(g)
        g.expire(id="q", version=1, now=DEADLINE)
        with self.assertRaises(GateError):
            g.cancel(id="q", version=1, now=DEADLINE + 1)
        self.assertEqual(occupied(g), 0)  # no double release

    def test_tick_expires_in_deterministic_order(self):
        g = make_gate(capacity=100)
        reserve(g, "b", confirm_by=T0 + 100)
        reserve(g, "a", confirm_by=T0 + 100)
        reserve(g, "c", confirm_by=T0 + 50)
        reserve(g, "d", confirm_by=T0 + 5000)
        r = g.tick(now=T0 + 200)
        self.assertEqual([e["id"] for e in r["expired"]], ["c", "a", "b"])
        self.assertEqual(occupied(g), 3)  # only d remains


class TestVersionedIdReuse(unittest.TestCase):
    def test_late_cancel_cannot_release_newer_same_id_request(self):
        g = make_gate()
        reserve(g, "q", execute_at=T0, confirm_by=T0 + 100)
        g.tick(now=T0 + 200)  # v1 expires
        # Same id, genuinely new request (different execution time).
        r = reserve(g, "q", execute_at=T0 + 300, confirm_by=T0 + 400, now=T0 + 200)
        self.assertEqual(r["status"], "reserved")
        self.assertEqual(r["version"], 2)
        # A late cancel armed with the old version must not touch v2.
        with self.assertRaises(GateError) as ctx:
            g.cancel(id="q", version=1, now=T0 + 250)
        self.assertEqual(ctx.exception.code, "stale_version")
        self.assertEqual(occupied(g, at=T0 + 300), 3)
        # A stale expiry timer for v1 is equally inert.
        with self.assertRaises(GateError) as ctx:
            g.expire(id="q", version=1, now=T0 + 500)
        self.assertEqual(ctx.exception.code, "stale_version")
        # The new request lives on and can be confirmed with its version.
        self.assertEqual(g.confirm(id="q", version=2, now=T0 + 300)["status"],
                         "confirmed")

    def test_conflict_while_active(self):
        g = make_gate()
        reserve(g, "q")
        with self.assertRaises(GateError) as ctx:
            reserve(g, "q", execute_at=T0 + 10)
        self.assertEqual(ctx.exception.code, "id_conflict")


if __name__ == "__main__":
    unittest.main()
