import json
import unittest
from fractions import Fraction

from realroots import poly as P
from realroots.isolate import Engine, finalize, isolate, run
from realroots.jsonutil import dec_state, enc_state
from realroots import jsonutil

from helpers import linear, poly_from_roots


def six_root_poly():
    # roots: +-sqrt(2), 1, -3, +-sqrt(7)
    f = P.mul((Fraction(-2), Fraction(0), Fraction(1)),
              (Fraction(-7), Fraction(0), Fraction(1)))
    f = P.mul(f, linear(1))
    f = P.mul(f, linear(-3))
    return f


def make_engine(coeffs, eps):
    _, facs = P.squarefree_factors(P.normalize(coeffs))
    facs = [(fa, m) for fa, m in facs if P.degree(fa) >= 1]
    return Engine(facs, eps)


class TestSegmentedEqualsContinuous(unittest.TestCase):
    def test_segmented_run_matches_continuous(self):
        coeffs = six_root_poly()
        eps = Fraction(1, 64)
        status, roots_full, eng_full = isolate(coeffs, eps)
        self.assertEqual(status, "ok")

        eng = make_engine(coeffs, eps)
        segments = 0
        while True:
            # simulate persisting the frontier to JSON between segments
            state = json.loads(json.dumps(enc_state(eng)))
            eng = dec_state(state)
            status = run(eng, 3)  # tiny budget: 3 operations per segment
            segments += 1
            if status == "done":
                break
            self.assertLess(segments, 10000)
        roots_seg = finalize(eng.done, eng.factors)

        enc = jsonutil.enc_root
        self.assertEqual([enc(r) for r in roots_seg],
                         [enc(r) for r in roots_full])
        # same deterministic work: no repeated or wasted operations
        self.assertEqual(eng.ops, eng_full.ops)

    def test_no_duplicate_or_missing_roots(self):
        coeffs = six_root_poly()
        eng = make_engine(coeffs, Fraction(1, 128))
        while run(eng, 2) != "done":
            pass
        roots = finalize(eng.done, eng.factors)
        self.assertEqual(len(roots), 6)
        for a, b in zip(roots, roots[1:]):
            self.assertLess(a["hi"], b["lo"])  # strict separation, no dups

    def test_zero_budget_makes_no_progress(self):
        coeffs = six_root_poly()
        eng = make_engine(coeffs, None)
        self.assertEqual(run(eng, 0), "exhausted")
        self.assertEqual(eng.ops, 0)
        self.assertGreater(eng.pending(), 0)

    def test_exhaustion_marks_pending_frontier(self):
        coeffs = six_root_poly()
        eng = make_engine(coeffs, Fraction(1, 64))
        status = run(eng, 1)
        self.assertEqual(status, "exhausted")
        self.assertGreater(eng.pending(), 0)
        self.assertFalse(eng.finished)
        # state survives a JSON round trip with frontier intact
        eng2 = dec_state(json.loads(json.dumps(enc_state(eng))))
        self.assertEqual(eng2.pending(), eng.pending())
        self.assertEqual(eng2.ops, eng.ops)

    def test_resume_after_completion_is_noop(self):
        coeffs = poly_from_roots(1, 2)
        eng = make_engine(coeffs, None)
        self.assertEqual(run(eng), "done")
        ops = eng.ops
        self.assertEqual(run(eng, 10), "done")
        self.assertEqual(eng.ops, ops)

    def test_determinism_of_continuous_runs(self):
        coeffs = six_root_poly()
        _, roots_a, _ = isolate(coeffs, Fraction(1, 32))
        _, roots_b, _ = isolate(coeffs, Fraction(1, 32))
        self.assertEqual([jsonutil.enc_root(r) for r in roots_a],
                         [jsonutil.enc_root(r) for r in roots_b])


if __name__ == "__main__":
    unittest.main()
