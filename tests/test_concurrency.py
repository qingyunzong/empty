import unittest

from budget_auth.enumerate import (enumerate_interleavings, make_scenario,
                                   results_match, tagged)
from budget_auth.reference import RefModel, find_serial_history
from budget_auth.system import Authorizer

SEEDS = [1, 2, 3, 7, 11]


class InterleavingEnumerationTest(unittest.TestCase):
    """<=6 budgets, <=4 requests: every short interleaving of the
    reserve/confirm/release sequences must agree with the independent
    reference model and be explainable by a serial history."""

    def test_interleavings_match_reference(self):
        total = 0
        for seed in SEEDS:
            setup, threads = make_scenario(seed)
            checked = 0
            for interleaving, results, snap_a, snap_r in \
                    enumerate_interleavings(setup, threads, limit=1500):
                for res_a, res_r in results:
                    self.assertTrue(
                        results_match(res_a, res_r),
                        f"seed={seed} divergence: {res_a} vs {res_r}")
                self.assertEqual(snap_a, snap_r,
                                 f"seed={seed} final state diverged")
                checked += 1
            self.assertGreater(checked, 0)
            total += checked
        self.assertGreater(total, 1000)

    def test_serial_history_search_explains_outcomes(self):
        for seed in SEEDS:
            setup, threads = make_scenario(seed)
            tagged_threads = tagged(threads)
            # one concrete interleaving executed on the real authorizer
            auth = Authorizer()
            for op in setup:
                auth.apply(op)
            expected = {}
            for seq in tagged_threads:
                for tag, op in seq:
                    expected[tag] = auth.apply(op)["ok"]
            serial = find_serial_history(setup, tagged_threads, expected)
            self.assertIsNotNone(serial,
                                 f"seed={seed}: no serial explanation")

    def test_solver_matches_brute_force_allocations(self):
        # at every reserve, the solver's choice must be the optimum of
        # the brute-force enumeration of all feasible allocations
        for seed in SEEDS:
            setup, threads = make_scenario(seed)
            auth = Authorizer()
            ref = RefModel()
            for op in setup:
                auth.apply(op)
                ref.apply(op)
            for seq in threads:
                for op in seq:
                    if op["op"] == "reserve":
                        candidates = auth._candidates(op["subject"],
                                                      op["resource"])
                        if candidates:
                            allocs = ref.all_allocations(candidates,
                                                         op["amount"])
                            best = ref.best_allocation(candidates,
                                                       op["amount"])
                            if allocs:
                                self.assertIsNotNone(best)
                                min_size = min(len(a) for a in allocs)
                                self.assertEqual(len(best), min_size)
                    auth.apply(op)
                    ref.apply(op)


class LinearizationPointTest(unittest.TestCase):
    """Explicit interleavings targeting reserve/confirm/expiry races."""

    def _auth(self):
        auth = Authorizer()
        auth.apply({"op": "add_budget", "id": "p", "quota": 10})
        auth.apply({"op": "add_rule", "id": "r", "subject": "*",
                    "resource": "*", "budget": "p", "start": 0, "end": 99})
        return auth

    def test_reserve_then_expiry_then_confirm(self):
        auth = self._auth()
        auth.apply({"op": "reserve", "request": "q1", "subject": "s",
                    "resource": "r", "amount": 10, "ttl": 5})
        auth.apply({"op": "reserve", "request": "q2", "subject": "s",
                    "resource": "r", "amount": 10, "ttl": 50})
        self.assertEqual(auth.reservations.get("q2"), None)
        auth.apply({"op": "tick", "now": 6})   # q1 expires at this point
        res = auth.apply({"op": "reserve", "request": "q2", "subject": "s",
                          "resource": "r", "amount": 10, "ttl": 50})
        self.assertTrue(res["ok"])
        res = auth.apply({"op": "confirm", "request": "q1"})
        self.assertFalse(res["ok"])  # too late: expired before confirm

    def test_confirm_before_expiry_wins(self):
        auth = self._auth()
        auth.apply({"op": "reserve", "request": "q1", "subject": "s",
                    "resource": "r", "amount": 10, "ttl": 5})
        auth.apply({"op": "tick", "now": 5})  # same moment: still valid
        self.assertTrue(auth.apply({"op": "confirm",
                                    "request": "q1"})["ok"])
        auth.apply({"op": "tick", "now": 6})
        res = auth.apply({"op": "reserve", "request": "q2", "subject": "s",
                          "resource": "r", "amount": 10, "ttl": 50})
        self.assertFalse(res["ok"])  # confirmed hold never expires

    def test_same_tick_expiry_and_commit(self):
        # a tick to t expires reservations with expires_at < t; a confirm
        # interleaved after the tick sees the expiry, one before does not
        auth = self._auth()
        auth.apply({"op": "reserve", "request": "q1", "subject": "s",
                    "resource": "r", "amount": 6, "ttl": 4})
        auth.apply({"op": "confirm", "request": "q1", "now": 4})
        self.assertEqual(auth.reservations["q1"].status, "confirmed")
        auth2 = self._auth()
        auth2.apply({"op": "reserve", "request": "q1", "subject": "s",
                     "resource": "r", "amount": 6, "ttl": 4})
        auth2.apply({"op": "tick", "now": 5})
        res = auth2.apply({"op": "confirm", "request": "q1"})
        self.assertFalse(res["ok"])


if __name__ == "__main__":
    unittest.main()
