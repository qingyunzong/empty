import unittest
from fractions import Fraction

from algroots import IsolationSession, Poly, compare_roots


def factor_and_root(coeffs, index):
    session = IsolationSession(Poly(coeffs)).run()
    root = session.roots[index]
    return session.factors[root.factor][0], root


class TestCompare(unittest.TestCase):
    def test_sqrt2_lt_sqrt3(self):
        f1, r1 = factor_and_root(["-2", "0", "1"], 1)   # sqrt(2)
        f2, r2 = factor_and_root(["-3", "0", "1"], 1)   # sqrt(3)
        self.assertEqual(compare_roots(f1, r1, f2, r2), -1)
        self.assertEqual(compare_roots(f2, r2, f1, r1), 1)

    def test_common_root_equal(self):
        # f1 = x^2-2; f2 = (x^2-2)(x-7): share sqrt(2)
        f2poly = Poly(["-2", "0", "1"]) * Poly([-7, 1])
        f1, r1 = factor_and_root(["-2", "0", "1"], 1)
        f2, r2 = factor_and_root(f2poly.to_json(), 1)   # -sqrt2, sqrt2, 7
        self.assertEqual(compare_roots(f1, r1, f2, r2), 0)
        # sqrt(2) vs 7
        f2b, r2b = factor_and_root(f2poly.to_json(), 2)
        self.assertEqual(compare_roots(f1, r1, f2b, r2b), -1)

    def test_common_rational_root(self):
        # (x-2)(x-5) and (x-2)(x-9): share root 2
        p1 = Poly([-2, 1]) * Poly([-5, 1])
        p2 = Poly([-2, 1]) * Poly([-9, 1])
        f1, r1 = factor_and_root(p1.to_json(), 0)
        f2, r2 = factor_and_root(p2.to_json(), 0)
        self.assertEqual(compare_roots(f1, r1, f2, r2), 0)
        f2b, r2b = factor_and_root(p2.to_json(), 1)     # 9
        self.assertEqual(compare_roots(f1, r1, f2b, r2b), -1)

    def test_point_vs_interval(self):
        # 3/2 (exact point root of x^2-2x+3/4) vs sqrt(2) ~ 1.41421
        f1, r1 = factor_and_root([Fraction(3, 4), -2, 1], 1)
        self.assertTrue(r1.is_point)
        f2, r2 = factor_and_root(["-2", "0", "1"], 1)
        self.assertEqual(compare_roots(f1, r1, f2, r2), 1)
        self.assertEqual(compare_roots(f2, r2, f1, r1), -1)

    def test_close_roots_different_polys(self):
        eps = Fraction(1, 2 ** 30)
        f1, r1 = factor_and_root(["-2", "0", "1"], 1)            # sqrt(2)
        f2, r2 = factor_and_root([-2 - eps, 0, 1], 1)            # sqrt(2+eps)
        self.assertEqual(compare_roots(f1, r1, f2, r2), -1)
        self.assertEqual(compare_roots(f2, r2, f1, r1), 1)

    def test_equal_irrational_via_gcd(self):
        # same root, different minimal polynomials sharing a factor
        p1 = Poly(["-2", "0", "1"]) * Poly([1, 0, 1])      # (x^2-2)(x^2+1)
        p2 = Poly(["-2", "0", "1"]) * Poly([-3, 1])        # (x^2-2)(x-3)
        f1, r1 = factor_and_root(p1.to_json(), 1)          # sqrt(2)
        f2, r2 = factor_and_root(p2.to_json(), 1)          # sqrt(2)
        self.assertEqual(compare_roots(f1, r1, f2, r2), 0)

    def test_multiplicity_root_compare(self):
        # root 1 of (x-1)^3 vs root 1 of (x-1)(x-9): equal
        p1 = Poly([-1, 1]) ** 3
        p2 = Poly([-1, 1]) * Poly([-9, 1])
        f1, r1 = factor_and_root(p1.to_json(), 0)
        f2, r2 = factor_and_root(p2.to_json(), 0)
        self.assertEqual(compare_roots(f1, r1, f2, r2), 0)


if __name__ == "__main__":
    unittest.main()
