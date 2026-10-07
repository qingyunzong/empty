import unittest
from fractions import Fraction

from realroots import poly as P
from realroots.isolate import isolate, refine_root
from realroots.sturm import sturm_sequence

from helpers import linear, poly_from_roots, poly_pow, root_record_contains


class TestIsolateBasic(unittest.TestCase):
    def test_irrational_roots(self):
        status, roots, _ = isolate([-2, 0, 1])  # x^2 - 2
        self.assertEqual(status, "ok")
        self.assertEqual(len(roots), 2)
        neg, pos = roots
        self.assertLess(neg["hi"], pos["lo"])  # strictly separated
        self.assertLess(neg["lo"], -1)
        self.assertGreater(neg["hi"], -2)
        self.assertLess(pos["lo"] ** 2, 2)
        self.assertGreater(pos["hi"] ** 2, 2)

    def test_point_roots_hit_by_bisection(self):
        # x^2 - 4x + 3 = (x-1)(x-3); dyadic mids land exactly on 1 and 3
        status, roots, _ = isolate([3, -4, 1], eps=Fraction(1))
        self.assertEqual(status, "ok")
        self.assertEqual([r["kind"] for r in roots], ["point", "point"])
        self.assertEqual([r["lo"] for r in roots], [Fraction(1), Fraction(3)])

    def test_sorted_and_separated(self):
        f = poly_from_roots(-3, -1, 0, 2, 5)
        status, roots, _ = isolate(f, eps=Fraction(1, 8))
        self.assertEqual(status, "ok")
        self.assertEqual(len(roots), 5)
        for a, b in zip(roots, roots[1:]):
            self.assertLess(a["hi"], b["lo"])

    def test_constant_polynomial_has_no_roots(self):
        status, roots, _ = isolate([5])
        self.assertEqual(status, "ok")
        self.assertEqual(roots, [])

    def test_zero_polynomial_rejected(self):
        with self.assertRaises(ValueError):
            isolate([0, 0, 0])


class TestMultiplicity(unittest.TestCase):
    def test_high_multiplicity_roots(self):
        f = P.mul(poly_pow(linear(1), 4),
                  P.mul(poly_pow(linear(-2), 3), linear(3)))
        status, roots, _ = isolate(f, eps=Fraction(1, 4))
        self.assertEqual(status, "ok")
        self.assertEqual(len(roots), 3)
        by_mult = {}
        for r in roots:
            by_mult[r["multiplicity"]] = r
        self.assertTrue(root_record_contains(by_mult[3], -2))
        self.assertTrue(root_record_contains(by_mult[4], 1))
        self.assertTrue(root_record_contains(by_mult[1], 3))

    def test_multiplicity_one_for_squarefree(self):
        status, roots, _ = isolate(poly_from_roots(1, 2))
        self.assertTrue(all(r["multiplicity"] == 1 for r in roots))


class TestCloseRoots(unittest.TestCase):
    def test_roots_2_pow_30_apart(self):
        gap = Fraction(1, 2 ** 30)
        f = poly_from_roots(1, 1 + gap)
        status, roots, _ = isolate(f)
        self.assertEqual(status, "ok")
        self.assertEqual(len(roots), 2)
        a, b = roots
        self.assertLess(a["hi"], b["lo"])  # separated despite tiny gap
        self.assertTrue(root_record_contains(a, 1))
        self.assertTrue(root_record_contains(b, 1 + gap))

    def test_refine_below_gap(self):
        gap = Fraction(1, 2 ** 30)
        f = poly_from_roots(1, 1 + gap)
        status, roots, _ = isolate(f)
        g = P.monic(f)
        refined = [refine_root(g, r, Fraction(1, 2 ** 40)) for r in roots]
        for r in refined:
            if r["kind"] == "interval":
                self.assertLessEqual(r["hi"] - r["lo"], Fraction(1, 2 ** 40))


class TestHugeCoefficients(unittest.TestCase):
    def test_huge_leading_coefficient(self):
        big = 10 ** 40
        status, roots, _ = isolate([-1, 0, big])  # 10^40 x^2 - 1
        self.assertEqual(status, "ok")
        self.assertEqual(len(roots), 2)
        pos = roots[1]
        self.assertTrue(root_record_contains(pos, Fraction(1, 10 ** 20)))

    def test_huge_and_tiny_roots(self):
        # (10^30 x - 1)(x - 10^30): roots 10^-30 and 10^30
        f = P.mul((Fraction(-1), Fraction(10 ** 30)),
                  (Fraction(-10 ** 30), Fraction(1)))
        status, roots, _ = isolate(f)
        self.assertEqual(status, "ok")
        self.assertEqual(len(roots), 2)
        small, large = roots
        self.assertTrue(root_record_contains(small, Fraction(1, 10 ** 30)))
        self.assertTrue(root_record_contains(large, 10 ** 30))

    def test_refine_huge_root(self):
        f = P.mul(linear(10 ** 30), linear(-10 ** 30))  # x^2 - 10^60
        status, roots, _ = isolate(f)
        g = P.monic(f)
        refined = refine_root(g, roots[1], Fraction(1))
        self.assertLessEqual(refined["hi"] - refined["lo"], 1)
        self.assertTrue(root_record_contains(refined, 10 ** 30))


class TestRefine(unittest.TestCase):
    def test_refine_to_eps(self):
        status, roots, _ = isolate([-2, 0, 1])
        g = P.monic((Fraction(-2), Fraction(0), Fraction(1)))
        pos = refine_root(g, roots[1], Fraction(1, 2 ** 30))
        self.assertLessEqual(pos["hi"] - pos["lo"], Fraction(1, 2 ** 30))
        self.assertLess(pos["lo"] ** 2, 2)
        self.assertGreater(pos["hi"] ** 2, 2)

    def test_refine_interval_becomes_point(self):
        # refining (0,2) for x-1 hits the exact root 1
        g = linear(1)
        root = {"kind": "interval", "lo": Fraction(0), "hi": Fraction(2),
                "factor": 0, "multiplicity": 1}
        out = refine_root(g, root, Fraction(1, 100))
        self.assertEqual(out["kind"], "point")
        self.assertEqual(out["lo"], 1)


if __name__ == "__main__":
    unittest.main()
