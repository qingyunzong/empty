import unittest

from budget_auth.system import Authorizer


def base(**kw):
    auth = Authorizer()
    auth.apply({"op": "add_budget", "id": "p", "quota": 100})
    auth.apply({"op": "add_budget", "id": "a", "quota": 60, "parent": "p"})
    auth.apply({"op": "add_budget", "id": "b", "quota": 60, "parent": "p"})
    auth.apply({"op": "add_rule", "id": "ra", "subject": "alice",
                "resource": "gpu", "budget": "a", "start": 0, "end": 100})
    auth.apply({"op": "add_rule", "id": "rb", "subject": "alice",
                "resource": "gpu", "budget": "b", "start": 0, "end": 100})
    return auth


class LifecycleTest(unittest.TestCase):
    def test_reserve_confirm_release(self):
        auth = base()
        res = auth.apply({"op": "reserve", "request": "q1",
                          "subject": "alice", "resource": "gpu",
                          "amount": 30, "ttl": 10})
        self.assertTrue(res["ok"])
        self.assertEqual(res["holds"], {"a": 30})
        self.assertEqual(auth._used()["p"], 30)
        self.assertTrue(auth.apply({"op": "confirm", "request": "q1"})["ok"])
        # confirmed usage persists
        self.assertEqual(auth._used()["p"], 30)
        # confirmed reservation cannot be released
        res = auth.apply({"op": "release", "request": "q1"})
        self.assertEqual(res["error"], "invalid_status")
        self.assertEqual(auth._used()["p"], 30)

    def test_release_frees_quota(self):
        auth = base()
        auth.apply({"op": "reserve", "request": "q1", "subject": "alice",
                    "resource": "gpu", "amount": 60, "ttl": 10})
        self.assertTrue(auth.apply({"op": "release", "request": "q1"})["ok"])
        self.assertEqual(auth._used()["p"], 0)
        res = auth.apply({"op": "reserve", "request": "q2",
                          "subject": "alice", "resource": "gpu",
                          "amount": 60, "ttl": 10})
        self.assertTrue(res["ok"])

    def test_duplicate_confirm_rejected_once_deducted(self):
        auth = base()
        auth.apply({"op": "reserve", "request": "q1", "subject": "alice",
                    "resource": "gpu", "amount": 25, "ttl": 10})
        self.assertTrue(auth.apply({"op": "confirm", "request": "q1"})["ok"])
        used_after_first = dict(auth._used())
        res = auth.apply({"op": "confirm", "request": "q1"})
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"], "invalid_status")
        self.assertEqual(res["status"], "confirmed")
        self.assertEqual(auth._used(), used_after_first)

    def test_no_matching_rule(self):
        auth = base()
        res = auth.apply({"op": "reserve", "request": "q1",
                          "subject": "mallory", "resource": "gpu",
                          "amount": 5, "ttl": 5})
        self.assertEqual(res["error"], "no_matching_rule")

    def test_rule_time_window(self):
        auth = base()
        auth.apply({"op": "tick", "now": 50})
        auth.apply({"op": "add_rule", "id": "late", "subject": "bob",
                    "resource": "*", "budget": "a", "start": 60, "end": 70})
        res = auth.apply({"op": "reserve", "request": "q1",
                          "subject": "bob", "resource": "gpu",
                          "amount": 5, "ttl": 5})
        self.assertEqual(res["error"], "no_matching_rule")
        auth.apply({"op": "tick", "now": 65})
        res = auth.apply({"op": "reserve", "request": "q1",
                          "subject": "bob", "resource": "gpu",
                          "amount": 5, "ttl": 5})
        self.assertTrue(res["ok"])

    def test_shared_parent_budget_across_requests(self):
        auth = base()
        auth.apply({"op": "reserve", "request": "q1", "subject": "alice",
                    "resource": "gpu", "amount": 60, "ttl": 10})
        # parent p has 100; q1 took a:60 -> p has 40 left
        res = auth.apply({"op": "reserve", "request": "q2",
                          "subject": "alice", "resource": "gpu",
                          "amount": 50, "ttl": 10})
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"], "insufficient_capacity")
        self.assertEqual(res["unsat"]["allocatable"], 40)
        res = auth.apply({"op": "reserve", "request": "q2",
                          "subject": "alice", "resource": "gpu",
                          "amount": 40, "ttl": 10})
        self.assertTrue(res["ok"])
        self.assertEqual(res["holds"], {"b": 40})

    def test_partial_reserve_failure_is_atomic(self):
        auth = base()
        auth.apply({"op": "reserve", "request": "q1", "subject": "alice",
                    "resource": "gpu", "amount": 55, "ttl": 10})
        before = auth.snapshot()
        # needs 50 more than the 45 left under p -> must fail cleanly
        res = auth.apply({"op": "reserve", "request": "q2",
                          "subject": "alice", "resource": "gpu",
                          "amount": 50, "ttl": 10})
        self.assertFalse(res["ok"])
        self.assertEqual(auth.snapshot(), before)
        self.assertNotIn("q2", auth.reservations)

    def test_quota_decrease_conflicts_with_pending_reservation(self):
        auth = base()
        auth.apply({"op": "reserve", "request": "q1", "subject": "alice",
                    "resource": "gpu", "amount": 80, "ttl": 10})
        self.assertTrue(auth.apply(
            {"op": "set_quota", "budget": "p", "quota": 50})["ok"])
        # existing reservation still counts: nothing left for new ones
        res = auth.apply({"op": "reserve", "request": "q2",
                          "subject": "alice", "resource": "gpu",
                          "amount": 10, "ttl": 10})
        self.assertFalse(res["ok"])
        self.assertEqual(res["unsat"]["allocatable"], 0)
        # the pre-existing reservation is grandfathered and confirmable
        self.assertTrue(auth.apply({"op": "confirm", "request": "q1"})["ok"])

    def test_clock_regression_rejected(self):
        auth = base()
        auth.apply({"op": "tick", "now": 10})
        res = auth.apply({"op": "tick", "now": 5})
        self.assertEqual(res["error"], "clock_regression")
        self.assertEqual(auth.now, 10)


class ExpiryTest(unittest.TestCase):
    def test_confirm_at_expiry_moment(self):
        auth = base()
        auth.apply({"op": "reserve", "request": "q1", "subject": "alice",
                    "resource": "gpu", "amount": 10, "ttl": 5})
        auth.apply({"op": "tick", "now": 5})
        res = auth.apply({"op": "confirm", "request": "q1"})
        self.assertTrue(res["ok"])

    def test_late_confirm_rejected(self):
        auth = base()
        auth.apply({"op": "reserve", "request": "q1", "subject": "alice",
                    "resource": "gpu", "amount": 10, "ttl": 5})
        auth.apply({"op": "tick", "now": 6})
        res = auth.apply({"op": "confirm", "request": "q1"})
        self.assertFalse(res["ok"])
        self.assertEqual(res["status"], "expired")
        self.assertEqual(auth._used()["p"], 0)

    def test_late_confirm_does_not_touch_others_quota(self):
        auth = base()
        auth.apply({"op": "reserve", "request": "q1", "subject": "alice",
                    "resource": "gpu", "amount": 60, "ttl": 5})
        auth.apply({"op": "tick", "now": 10})  # q1 expires, quota freed
        res = auth.apply({"op": "reserve", "request": "q2",
                          "subject": "alice", "resource": "gpu",
                          "amount": 100, "ttl": 50})
        self.assertTrue(res["ok"])
        self.assertEqual(res["holds"], {"a": 60, "b": 40})
        # late confirm of the expired reservation must be rejected and
        # must not release or alter q2's holds
        res = auth.apply({"op": "confirm", "request": "q1"})
        self.assertFalse(res["ok"])
        self.assertEqual(auth._used()["p"], 100)
        self.assertEqual(auth.reservations["q2"].holds, {"a": 60, "b": 40})
        self.assertTrue(auth.apply({"op": "confirm", "request": "q2"})["ok"])
        self.assertEqual(auth._used()["p"], 100)

    def test_expired_reservation_frees_quota(self):
        auth = base()
        auth.apply({"op": "reserve", "request": "q1", "subject": "alice",
                    "resource": "gpu", "amount": 60, "ttl": 5})
        auth.apply({"op": "tick", "now": 6})
        res = auth.apply({"op": "reserve", "request": "q2",
                          "subject": "alice", "resource": "gpu",
                          "amount": 60, "ttl": 5})
        self.assertTrue(res["ok"])


if __name__ == "__main__":
    unittest.main()
