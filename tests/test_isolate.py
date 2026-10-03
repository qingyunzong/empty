import unittest
from fractions import Fraction

from algroots import IsolationSession, Poly, isolate, refine_to


def roots_of(coeffs):
    return isolate(Poly(coeffs)).roots


class TestIsolate(unittest.TestCase):
    def test_sqrt2_interval(self):
        roots = roots_of(["-2", "0", "1"])
        self.assertEqual(len(roots), 2)
        pos = roots[1]
        self.assertFalse(pos.is_point)
        self.assertLess(pos.lower, pos.upper)
        self.assertLess(pos.lower, Fraction(3, 2))
        self.assertGreater(pos.upper, Fraction(7, 5))
        f = Poly(["-2", "0", "1"])
        self.assertLess(f.evaluate(pos.lower) * f.evaluate(pos.upper), 0)
        for r in roots:
            self.assertEqual(r.multiplicity, 1)

    def test_refine_to_epsilon(self):
        session = isolate(Poly(["-2", "0", "1"]))
        root = session.roots[1]
        f = session.factors[root.factor][0]
        eps = Fraction(1, 10 ** 8)
        root, done = refine_to(f, root, eps)
        self.assertTrue(done)
        self.assertLessEqual(root.width(), eps)
        # sqrt(2) stays inside
        self.assertLess(f.evaluate(root.lower) * f.evaluate(root.upper), 0)

    def test_high_multiplicity(self):
        # (x-1)^5 (x+1)^4 (x^2+1): real roots -1 (mult 4), 1 (mult 5)
        p = (Poly([-1, 1]) ** 5) * (Poly([1, 1]) ** 4) * Poly([1, 0, 1])
        roots = roots_of(p.to_json())
        self.assertEqual(len(roots), 2)
        self.assertEqual(roots[0].multiplicity, 4)
        self.assertEqual(roots[1].multiplicity, 5)
        self.assertTrue(roots[0].contains(-1))
        self.assertTrue(roots[1].contains(1))

    def test_endpoint_root_is_point(self):
        # x^3 - 4x = x(x-2)(x+2): bisection midpoint hits 0 exactly
        roots = roots_of(["0", "-4", "0", "1"])
        self.assertEqual(len(roots), 3)
        self.assertTrue(roots[1].is_point)
        self.assertEqual(roots[1].value, 0)
        self.assertTrue(roots[0].contains(-2))
        self.assertTrue(roots[2].contains(2))

    def test_dyadic_root_becomes_point(self):
        # x^2 - 2x + 3/4 = (x - 1/2)(x - 3/2); 3/2 is hit as a midpoint
        roots = roots_of([Fraction(3, 4), -2, 1])
        self.assertEqual(len(roots), 2)
        points = [r for r in roots if r.is_point]
        self.assertEqual(len(points), 1)
        self.assertEqual(points[0].value, Fraction(3, 2))
        intervals = [r for r in roots if not r.is_point]
        self.assertTrue(intervals[0].contains(Fraction(1, 2)))

    def test_close_roots_separated(self):
        # roots sqrt(2) and sqrt(2 + 2^-30), distance ~ 2^-31.6
        eps = Fraction(1, 2 ** 30)
        f = Poly([-2, 0, 1]) * Poly([-2 - eps, 0, 1])
        session = isolate(f)
        self.assertEqual(len(session.roots), 4)
        for r in session.roots:
            self.assertFalse(r.is_point)
        # pairwise disjoint and sorted
        for a, b in zip(session.roots, session.roots[1:]):
            self.assertLessEqual(a.upper, b.lower)
        # the two positive roots are distinct and both near sqrt(2)
        p1, p2 = session.roots[2], session.roots[3]
        self.assertLessEqual(p1.upper, p2.lower)
        # sqrt(2) ~ 1.41421356 lies strictly inside p1
        self.assertLess(p1.lower, Fraction(14143, 10000))
        self.assertGreater(p1.upper, Fraction(14142, 10000))

    def test_constant_polynomial(self):
        self.assertEqual(roots_of([7]), [])
        self.assertEqual(roots_of([-3]), [])

    def test_zero_polynomial_rejected(self):
        with self.assertRaises(ValueError):
            IsolationSession(Poly([]))
        with self.assertRaises(ValueError):
            IsolationSession(Poly([0, 0, 0]))

    def test_huge_coefficients(self):
        big = 10 ** 40
        # (10^40 x - 1)(x - 10^40): roots 10^-40 and 10^40
        p = Poly([-1, big]) * Poly([-big, 1])
        roots = roots_of(p.to_json())
        self.assertEqual(len(roots), 2)
        self.assertTrue(roots[0].contains(Fraction(1, big)))
        self.assertTrue(roots[1].contains(big))

    def test_no_real_roots(self):
        self.assertEqual(roots_of([1, 0, 1]), [])            # x^2+1
        self.assertEqual(roots_of([1, 1, 1]), [])            # x^2+x+1
        p = Poly([1, 0, 1]) * Poly([2, 0, 1])                # (x^2+1)(x^2+2)
        self.assertEqual(roots_of(p.to_json()), [])
