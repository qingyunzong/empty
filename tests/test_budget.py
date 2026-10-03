import json
import unittest
from fractions import Fraction

from algroots import Budget, BudgetExhausted, IsolationSession, Poly, refine_to


def make_poly():
    # roots: -2, -sqrt(2), 0 (point), sqrt(2), 2
    return Poly(["0", "-4", "0", "1"]) * Poly(["-2", "0", "1"])


class TestBudget(unittest.TestCase):
    def test_budget_exhaustion_marks_pending(self):
        session = IsolationSession(make_poly())
        session.run(budget=0)
        self.assertEqual(session.status, "pending")
        self.assertFalse(session.done)
        self.assertTrue(session.frontier)

    def test_stats_counted(self):
        session = IsolationSession(make_poly()).run()
        self.assertGreater(session.stats["remainders"], 0)
        self.assertGreater(session.stats["bisections"], 0)

    def test_segmented_matches_continuous(self):
        # continuous run
        full = IsolationSession(make_poly()).run()
        expected = [r.to_json() for r in full.roots]

        # segmented run: 2 budget units per slice, JSON state round-trips
        session = IsolationSession(make_poly())
        slices = 0
        while not session.done:
            session.run(budget=2)
            state = json.loads(json.dumps(session.to_state()))
            session = IsolationSession.from_state(state)
            slices += 1
            self.assertLess(slices, 10000)
        self.assertGreater(slices, 1)  # really was segmented
        self.assertEqual([r.to_json() for r in session.roots], expected)

    def test_resume_no_duplicate_or_missing_roots(self):
        full = IsolationSession(make_poly()).run()
        expected = sorted(str(r.to_json()) for r in full.roots)

        session = IsolationSession(make_poly())
        seen = []
        while not session.done:
            session.run(budget=1)
            state = json.loads(json.dumps(session.to_state()))
            session = IsolationSession.from_state(state)
            # roots reported so far must never contain duplicates
            got = [str(r.to_json()) for r in session.roots]
            self.assertEqual(len(got), len(set(got)))
            seen = got
        self.assertEqual(sorted(seen), expected)

    def test_refine_budget(self):
        session = IsolationSession(Poly(["-2", "0", "1"])).run()
        root = session.roots[1]
        f = session.factors[root.factor][0]
        wider, done = refine_to(f, root, "1/1000000", Budget(2))
        self.assertFalse(done)
        self.assertLess(wider.width(), root.width())  # frontier advanced
        narrower, done = refine_to(f, wider, "1/1000000", Budget(None))
        self.assertTrue(done)
        self.assertLessEqual(narrower.width(), 1 / 1000000)

    def test_state_roundtrip_preserves_pending_work(self):
        session = IsolationSession(make_poly())
        session.run(budget=3)
        self.assertEqual(session.status, "pending")
        restored = IsolationSession.from_state(
            json.loads(json.dumps(session.to_state())))
        self.assertEqual(restored.status, "pending")
        restored.run()
        self.assertEqual(restored.status, "done")
        full = IsolationSession(make_poly()).run()
        self.assertEqual([r.to_json() for r in restored.roots],
                         [r.to_json() for r in full.roots])

    def test_segmented_close_roots_and_cross_factor_finalize(self):
        # Two factors whose isolating intervals overlap heavily; the
        # cross-factor disjointness refinement runs under a tiny budget.
        eps = Fraction(1, 2 ** 20)
        poly = Poly([-2, 0, 1]) * Poly([-2 - eps, 0, 1])
        full = IsolationSession(poly).run()
        expected = [r.to_json() for r in full.roots]

        session = IsolationSession(poly)
        slices = 0
        while not session.done:
            session.run(budget=1)
            state = json.loads(json.dumps(session.to_state()))
            session = IsolationSession.from_state(state)
            slices += 1
            self.assertLess(slices, 100000)
        self.assertEqual([r.to_json() for r in session.roots], expected)


if __name__ == "__main__":
    unittest.main()
