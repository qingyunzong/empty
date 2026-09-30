import unittest

from budget_auth import Authorizer


def base_auth():
    a = Authorizer()
    a.add_budget("root", 100)
    a.add_budget("a", 60, parent="root")
    a.add_budget("b", 60, parent="root")
    a.add_rule("ra", "alice", "doc/*", 0, 1000, "a")
    a.add_rule("rb", "alice", "doc/*", 0, 1000, "b")
    return a


class LifecycleTest(unittest.TestCase):
    def test_reserve_confirm_release_accounting(self):
        auth = base_auth()
        r = auth.reserve("q1", "alice", "doc/1", 40, ttl=10)
        self.assertTrue(r["ok"])
        self.assertEqual(auth.held["a"], 40)
        self.assertEqual(auth.held["root"], 40)  # shared parent charged once
        self.assertTrue(auth.confirm("q1")["ok"])
        self.assertEqual(auth.held["root"], 40)  # confirm keeps deduction
        auth.check_invariants()

    def test_release_frees_whole_chain(self):
        auth = base_auth()
        auth.reserve("q1", "alice", "doc/1", 40, ttl=10)
        self.assertTrue(auth.release("q1")["ok"])
        self.assertEqual(auth.held["root"], 0)
        self.assertEqual(auth.held["a"], 0)
        auth.check_invariants()

    def test_request_spans_multiple_budgets_atomically(self):
        auth = base_auth()
        r = auth.reserve("q1", "alice", "doc/1", 90, ttl=10)
        self.assertTrue(r["ok"])
        self.assertEqual(r["reservation"]["allocation"], {"a": 60, "b": 30})
        self.assertEqual(auth.held["root"], 90)
        auth.check_invariants()

    def test_partial_reserve_failure_rolls_back(self):
        auth = base_auth()
        auth.reserve("q0", "alice", "doc/0", 50, ttl=10)  # root: 50 left
        before = auth.state()
        # needs two budgets; combined constraints cannot satisfy 80
        r = auth.reserve("q1", "alice", "doc/1", 80, ttl=10)
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "insufficient_budget")
        self.assertIn("unsat_core", r)
        self.assertEqual(auth.state(), before)  # nothing held, no residue
        auth.check_invariants()

    def test_rule_window_and_subject_conditions(self):
        auth = Authorizer()
        auth.add_budget("w", 10)
        auth.add_rule("r", "bob", "res/*", 5, 10, "w")
        auth.advance_time(3)
        self.assertEqual(auth.reserve("q1", "bob", "res/1", 1, 1)["error"]
                         ["code"], "no_matching_rule")  # too early
        self.assertEqual(auth.reserve("q2", "alice", "res/1", 1, 1)["error"]
                         ["code"], "no_matching_rule")  # wrong subject
        auth.advance_time(5)
        self.assertTrue(auth.reserve("q3", "bob", "res/1", 1, 1)["ok"])


class QuotaConflictTest(unittest.TestCase):
    def test_quota_decrease_conflicts_with_unconfirmed_reservation(self):
        auth = base_auth()
        auth.reserve("q1", "alice", "doc/1", 40, ttl=100)
        r = auth.set_quota("a", 30)
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "quota_conflict")
        self.assertEqual(r["error"]["held"], 40)
        self.assertEqual(r["error"]["requested"], 30)
        # decrease to exactly the held amount is allowed
        self.assertTrue(auth.set_quota("a", 40)["ok"])
        auth.check_invariants()

    def test_quota_decrease_after_release_succeeds(self):
        auth = base_auth()
        auth.reserve("q1", "alice", "doc/1", 40, ttl=100)
        auth.release("q1")
        self.assertTrue(auth.set_quota("a", 30)["ok"])


class ConfirmTest(unittest.TestCase):
    def test_duplicate_confirm_deducts_once(self):
        auth = base_auth()
        auth.reserve("q1", "alice", "doc/1", 40, ttl=10)
        self.assertTrue(auth.confirm("q1")["ok"])
        held_after_first = dict(auth.held)
        r = auth.confirm("q1")
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "duplicate_confirm")
        self.assertEqual(auth.held, held_after_first)  # no double deduction

    def test_expiry_same_tick_as_confirm(self):
        auth = base_auth()
        auth.reserve("q1", "alice", "doc/1", 40, ttl=5)  # expiry at t=5
        auth.advance_time(4)
        # confirm strictly before expiry linearizes fine
        r = auth.reserve("q2", "alice", "doc/2", 10, ttl=1)  # expiry t=5
        self.assertTrue(r["ok"])
        expired = auth.advance_time(5)
        self.assertEqual(sorted(expired["expired"]), ["q1", "q2"])
        r = auth.confirm("q1")
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "expired")
        self.assertEqual(auth.held["root"], 0)

    def test_late_confirm_does_not_release_others_quota(self):
        auth = base_auth()
        auth.reserve("q1", "alice", "doc/1", 50, ttl=5)
        auth.advance_time(5)                      # q1 expires, holds freed
        r2 = auth.reserve("q2", "alice", "doc/2", 50, ttl=100)
        self.assertTrue(r2["ok"])                 # quota re-reserved by q2
        held_before = dict(auth.held)
        r = auth.confirm("q1")                    # late confirm: reject
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "expired")
        self.assertEqual(auth.held, held_before)  # q2's quota untouched
        self.assertEqual(auth.held["a"], 50)
        auth.check_invariants()

    def test_expired_reservation_cannot_be_released_twice(self):
        auth = base_auth()
        auth.reserve("q1", "alice", "doc/1", 50, ttl=5)
        auth.advance_time(5)
        r = auth.release("q1")
        self.assertFalse(r["ok"])
        self.assertEqual(auth.held["root"], 0)
        auth.check_invariants()


if __name__ == "__main__":
    unittest.main()
