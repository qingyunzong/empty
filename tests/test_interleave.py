import unittest

from budget_auth import Authorizer, interleave


def shared_parent_factory():
    auth = Authorizer()
    auth.add_budget("root", 10)
    auth.add_budget("a", 10, parent="root")
    auth.add_budget("b", 10, parent="root")
    auth.add_rule("ra", "alice", "r/*", 0, 1000, "a")
    auth.add_rule("rb", "alice", "r/*", 0, 1000, "b")
    return auth


def six_budget_factory():
    auth = Authorizer()
    auth.add_budget("root", 12)
    for i in range(5):
        auth.add_budget(f"n{i}", 6, parent="root")
        auth.add_rule(f"r{i}", "alice", "r/*", 0, 1000, f"n{i}")
    return auth


def res(rid, amount, ttl=100):
    return {"op": "reserve", "request_id": rid, "subject": "alice",
            "resource": "r/x", "amount": amount, "ttl": ttl}


def con(rid):
    return {"op": "confirm", "request_id": rid}


def rel(rid):
    return {"op": "release", "request_id": rid}


class SharedParentRaceTest(unittest.TestCase):
    def test_two_requests_race_on_shared_parent(self):
        threads = [[res("q1", 7), con("q1")], [res("q2", 7), con("q2")]]
        histories = list(interleave.enumerate_interleavings(threads))
        self.assertEqual(len(histories), 6)
        for h in histories:
            history = interleave.run_history(shared_parent_factory, h)
            oks = [s for s in history["steps"]
                   if s["op"]["op"] == "reserve" and s["result"]["ok"]]
            # 7+7 > root's 10: exactly one reserve may succeed
            self.assertEqual(len(oks), 1)
            # every concurrent history must have a serial explanation
            witness = interleave.find_serial_witness(
                shared_parent_factory, threads, history)
            self.assertIsNotNone(witness)
            # the serial witness reproduces the same final state
            auth = shared_parent_factory()
            for (t, k) in witness:
                interleave.execute(auth, threads[t][k])
            self.assertEqual(auth.state(), history["final"])

    def test_reserve_release_confirm_interleavings(self):
        threads = [[res("q1", 6), rel("q1")], [res("q2", 6), con("q2")]]
        for h in interleave.enumerate_interleavings(threads):
            history = interleave.run_history(shared_parent_factory, h)
            witness = interleave.find_serial_witness(
                shared_parent_factory, threads, history)
            self.assertIsNotNone(witness)


class ExpiryRaceTest(unittest.TestCase):
    def test_confirm_races_with_expiry_tick(self):
        threads = [[res("q1", 5, ttl=5), con("q1")],
                   [{"op": "advance_time", "now": 5}]]
        outcomes = set()
        for h in interleave.enumerate_interleavings(threads):
            history = interleave.run_history(shared_parent_factory, h)
            witness = interleave.find_serial_witness(
                shared_parent_factory, threads, history)
            self.assertIsNotNone(witness)
            confirm_step = [s for s in history["steps"]
                            if s["op"]["op"] == "confirm"][0]
            outcomes.add(confirm_step["result"]["ok"])
            # in every history the budget ends consistent
            self.assertIn(history["final"]["budgets"]["root"]["held"],
                          (0, 5))
        # both linearization orders are observable
        self.assertEqual(outcomes, {True, False})

    def test_late_confirm_never_frees_others_quota_in_any_interleaving(self):
        threads = [
            [res("q1", 6, ttl=5), con("q1")],
            [{"op": "advance_time", "now": 5}],
            [res("q2", 6), con("q2")],
        ]
        for h in interleave.enumerate_interleavings(threads):
            history = interleave.run_history(shared_parent_factory, h)
            held = history["final"]["budgets"]["root"]["held"]
            self.assertGreaterEqual(held, 0)
            self.assertLessEqual(held, 10)
            witness = interleave.find_serial_witness(
                shared_parent_factory, threads, history)
            self.assertIsNotNone(witness)


class FourRequestExhaustiveTest(unittest.TestCase):
    """<=6 budgets, <=4 requests: enumerate every short interleaving and
    validate invariants plus serializability against the independent
    serial history search."""

    def test_all_interleavings_of_four_requests(self):
        threads = [[res("q1", 4), con("q1")],
                   [res("q2", 5), con("q2")],
                   [res("q3", 6), rel("q3")],
                   [res("q4", 3), con("q4")]]
        count = 0
        for h in interleave.enumerate_interleavings(threads, max_ops=8):
            count += 1
            history = interleave.run_history(six_budget_factory, h)
            # invariants were checked after every op inside run_history;
            # here: global capacity on the shared root
            self.assertLessEqual(
                history["final"]["budgets"]["root"]["held"], 12)
            witness = interleave.find_serial_witness(
                six_budget_factory, threads, history)
            self.assertIsNotNone(witness)
        self.assertEqual(count, 2520)  # 8! / (2!^4)

    def test_quota_decrease_races_with_unconfirmed_reservation(self):
        threads = [
            [res("q1", 8), con("q1")],
            [{"op": "set_quota", "budget_id": "a", "quota": 4}],
        ]
        saw_conflict = False
        for h in interleave.enumerate_interleavings(threads):
            history = interleave.run_history(shared_parent_factory, h)
            for s in history["steps"]:
                if s["op"]["op"] == "set_quota" and not s["result"]["ok"]:
                    saw_conflict = True
                    self.assertEqual(s["result"]["error"]["code"],
                                     "quota_conflict")
            witness = interleave.find_serial_witness(
                shared_parent_factory, threads, history)
            self.assertIsNotNone(witness)
        self.assertTrue(saw_conflict)


if __name__ == "__main__":
    unittest.main()
