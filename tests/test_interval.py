import unittest
from fractions import Fraction

from interval_newton.interval import Interval, horner_interval
from interval_newton.poly import deflate, derivative, poly_divmod, poly_gcd, trim


class IntervalArithmeticTest(unittest.TestCase):
    def test_add_and_mul(self):
        self.assertEqual(Interval(1, 2) + Interval(3, 4), Interval(4, 6))
        self.assertEqual(Interval(-1, 2) * Interval(3, 4), Interval(-4, 8))
        self.assertEqual(2 * Interval(1, 3), Interval(2, 6))

    def test_division(self):
        self.assertEqual(
            Interval(1, 2) / Interval(3, 4),
            Interval(Fraction(1, 4), Fraction(2, 3)),
        )
        with self.assertRaises(ZeroDivisionError):
            Interval(1) / Interval(-1, 1)

    def test_contains_zero_and_width(self):
        self.assertTrue(Interval(-1, 2).contains_zero())
        self.assertFalse(Interval(1, 2).contains_zero())
        self.assertEqual(Interval(0, Fraction(1, 3)).width, Fraction(1, 3))

    def test_horner_interval_encloses_range(self):
        # p(x) = x^2 - 2 over [1, 2]: true range [-1, 2].
        val = horner_interval([Fraction(-2), Fraction(0), Fraction(1)], 1, 2)
        self.assertLessEqual(val.lo, -1)
        self.assertGreaterEqual(val.hi, 2)
        self.assertTrue(val.contains_zero())


class PolyTest(unittest.TestCase):
    def test_derivative(self):
        self.assertEqual(derivative([Fraction(1), Fraction(2), Fraction(3)]),
                         [Fraction(2), Fraction(6)])

    def test_divmod_exact(self):
        # (x^2 - 1) / (x - 1) = x + 1
        quot, rem = poly_divmod([-1, 0, 1], [-1, 1])
        self.assertEqual(quot, [Fraction(1), Fraction(1)])
        self.assertEqual(rem, [Fraction(0)])

    def test_gcd_detects_common_factor(self):
        p = trim([2, -3, 1])   # (x-1)(x-2)
        q = trim([3, -4, 1])   # (x-1)(x-3)
        self.assertEqual(poly_gcd(p, q), [Fraction(-1), Fraction(1)])

    def test_deflate(self):
        self.assertEqual(deflate([-1, 0, 1], 1), [Fraction(1), Fraction(1)])


if __name__ == "__main__":
    unittest.main()
