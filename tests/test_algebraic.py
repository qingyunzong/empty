import unittest
from fractions import Fraction

from exactcalc import AlgebraicError, AlgebraicNumber
from exactcalc.polys import round_half_even_fraction


def ref_round_half_even(f):
    """Independent reference: pure rational arithmetic, no shared code."""
    f = Fraction(f)
    fl = f.numerator // f.denominator
    rem = f - fl
    if 2 * rem < 1:
        return fl
    if 2 * rem > 1:
        return fl + 1
    return fl if fl % 2 == 0 else fl + 1


def sqrt2(**kw):
    return AlgebraicNumber([-2, 0, 1], 1, 2, **kw)


class TestRounding(unittest.TestCase):
    def test_sqrt2(self):
        self.assertEqual(sqrt2().floor(), 1)
        self.assertEqual(sqrt2().ceil(), 2)
        self.assertEqual(sqrt2().round_half_even(), 1)

    def test_negative_irrational(self):
        neg = sqrt2().scale(-1, 1)
        self.assertEqual(neg.floor(), -2)
        self.assertEqual(neg.ceil(), -1)
        self.assertEqual(neg.round_half_even(), -1)

    def test_ties_to_even(self):
        cases = {
            "5/2": 2, "7/2": 4, "1/2": 0, "3/2": 2,
            "9/2": 4, "11/2": 6,
        }
        for text, want in cases.items():
            got = AlgebraicNumber.from_rational(Fraction(text)).round_half_even()
            self.assertEqual(got, want, text)

    def test_negative_half_integer_ties(self):
        cases = {
            "-1/2": 0, "-3/2": -2, "-5/2": -2, "-7/2": -4, "-9/2": -4,
        }
        for text, want in cases.items():
            got = AlgebraicNumber.from_rational(Fraction(text)).round_half_even()
            self.assertEqual(got, want, text)

    def test_negative_non_tie(self):
        self.assertEqual(
            AlgebraicNumber.from_rational(Fraction(-23, 10)).round_half_even(), -2)
        self.assertEqual(
            AlgebraicNumber.from_rational(Fraction(-27, 10)).round_half_even(), -3)

    def test_budget_zero_is_still_exact(self):
        # A depleted refinement budget must never force an approximate
        # decision: exact sign determination settles the answer.
        wide = AlgebraicNumber([-2, 0, 1], 0, 2)
        self.assertEqual(wide.floor(budget=0), 1)
        self.assertEqual(AlgebraicNumber([-2, 0, 1], 0, 2).ceil(budget=0), 2)
        self.assertEqual(AlgebraicNumber([-2, 0, 1], 0, 2).round_half_even(budget=0), 1)
        big = 10 ** 30
        near = AlgebraicNumber([-(big ** 2 + 1), 0, 1], big, big + 1)
        self.assertEqual(near.floor(budget=0), big)

    def test_huge_boundary(self):
        m = 10 ** 20 + 7
        # sqrt(m^2 + 1): floor is exactly m.
        alg = AlgebraicNumber([-(m ** 2 + 1), 0, 1], m, m + 1)
        self.assertEqual(alg.floor(), m)
        self.assertEqual(alg.ceil(), m + 1)
        # sqrt(m^2) is exactly m even though the interval straddles it.
        exact = AlgebraicNumber([-m ** 2, 0, 1], m - 1, m + 1)
        self.assertEqual(exact.floor(), m)
        self.assertEqual(exact.ceil(), m)
        self.assertEqual(exact.round_half_even(), m)

    def test_exact_half_integer_via_refinement(self):
        # Root exactly at 3/2 discovered by bisection of x^2 - 9/4.
        alg = AlgebraicNumber([-81, 0, 4], 0, 5)  # 4x^2 - 81, root 9/2
        self.assertEqual(alg.round_half_even(), 4)  # 4.5 -> 4 (even)
        alg2 = AlgebraicNumber([-49, 0, 4], 3, 4)  # root 7/2
        self.assertEqual(alg2.round_half_even(), 4)  # 3.5 -> 4 (even)


class TestExhaustiveRationals(unittest.TestCase):
    def test_against_independent_rational_reference(self):
        for num in range(-60, 61):
            for den in range(1, 10):
                f = Fraction(num, den)
                alg = AlgebraicNumber.from_rational(f)
                self.assertEqual(alg.floor(), num // den, f)
                self.assertEqual(alg.ceil(), -((-num) // den), f)
                self.assertEqual(alg.round_half_even(), ref_round_half_even(f), f)
                self.assertEqual(round_half_even_fraction(f),
                                 ref_round_half_even(f), f)


class TestMultipleRootsAndIsolation(unittest.TestCase):
    def test_isolate_all_real_roots(self):
        # x^3 - 2x = x(x^2 - 2): roots -sqrt2, 0, sqrt2.
        roots = AlgebraicNumber.all_real_roots([0, -2, 0, 1])
        self.assertEqual(len(roots), 3)
        self.assertEqual([r.floor() for r in roots], [-2, 0, 1])
        self.assertEqual(roots[1].compare_to_rational(0), 0)

    def test_isolate_quartic(self):
        # (x^2-2)(x^2-3): four real roots.
        roots = AlgebraicNumber.all_real_roots([6, 0, -5, 0, 1])
        self.assertEqual(len(roots), 4)
        self.assertEqual([r.round_half_even() for r in roots], [-2, -1, 1, 2])

    def test_repeated_factor_polynomial(self):
        # (x^2 - 2)^2 is not squarefree; the library normalizes it.
        roots = AlgebraicNumber.all_real_roots([4, 0, -4, 0, 1])
        self.assertEqual(len(roots), 2)
        self.assertEqual([r.floor() for r in roots], [-2, 1])

    def test_invalid_specifications_rejected(self):
        with self.assertRaises(AlgebraicError):
            AlgebraicNumber([-2, 0, 1], 2, 1)          # lo >= hi
        with self.assertRaises(AlgebraicError):
            AlgebraicNumber([-2, 0, 1], -3, 3)         # two roots inside
        with self.assertRaises(AlgebraicError):
            AlgebraicNumber([-2, 0, 1], 3, 4)          # no root inside
        with self.assertRaises(AlgebraicError):
            AlgebraicNumber([5], 0, 1)                 # constant
        with self.assertRaises(AlgebraicError):
            AlgebraicNumber([-2, 0, 1], exact=Fraction(3, 2))  # not a root


class TestComparison(unittest.TestCase):
    def test_same_number_different_polynomials(self):
        a = AlgebraicNumber([-2, 0, 1], 1, 2)                       # x^2-2
        b = AlgebraicNumber([6, 0, -5, 0, 1], 1, Fraction(3, 2))    # (x^2-2)(x^2-3)
        c = AlgebraicNumber([4, 0, -4, 0, 1], 1, 2)                 # (x^2-2)^2
        self.assertEqual(a.compare(b), 0)
        self.assertEqual(b.compare(a), 0)
        self.assertEqual(a.compare(c), 0)
        self.assertEqual(a, b)
        self.assertEqual(a, c)

    def test_distinct_numbers(self):
        a = AlgebraicNumber([-2, 0, 1], 1, 2)                       # sqrt2
        d = AlgebraicNumber([6, 0, -5, 0, 1], Fraction(3, 2), 2)    # sqrt3
        self.assertEqual(a.compare(d), -1)
        self.assertEqual(d.compare(a), 1)
        self.assertNotEqual(a, d)

    def test_against_rationals(self):
        a = sqrt2()
        three_halves = AlgebraicNumber.from_rational(Fraction(3, 2))
        self.assertEqual(a.compare(three_halves), -1)
        self.assertEqual(three_halves.compare(a), 1)
        self.assertEqual(a.compare_to_rational(Fraction(1)), 1)
        self.assertEqual(a.compare_to_rational(Fraction(2)), -1)
        self.assertEqual(sqrt2().sign(), 1)
        self.assertEqual(sqrt2().scale(-1, 1).sign(), -1)

    def test_close_but_distinct(self):
        # sqrt2 vs 1414213/1000000: differ only after 6 decimals.
        a = sqrt2()
        near = AlgebraicNumber.from_rational(Fraction(1414214, 1000000))
        self.assertEqual(a.compare(near), -1)
        near2 = AlgebraicNumber.from_rational(Fraction(14142135, 10000000))
        self.assertEqual(a.compare(near2), 1)


class TestScaling(unittest.TestCase):
    def test_scaled_rounding(self):
        a = sqrt2()
        self.assertEqual(a.scaled_round(3, 2), 2)          # ~2.121
        self.assertEqual(a.scaled_round(1, 2), 1)          # ~0.707
        self.assertEqual(a.scaled_round(1, 2, mode="floor"), 0)
        self.assertEqual(a.scaled_round(1, 2, mode="ceil"), 1)
        self.assertEqual(a.scaled_round(-3, 2), -2)        # ~-2.121
        self.assertEqual(a.scaled_round(-3, 2, mode="floor"), -3)

    def test_scaled_properties(self):
        half_sqrt2 = sqrt2().scale(1, 2)
        self.assertEqual(half_sqrt2.floor(), 0)
        self.assertEqual(half_sqrt2.round_half_even(), 1)
        double = sqrt2().scale(2, 1)
        self.assertEqual(double.floor(), 2)
        # Scaling by a negative flips the interval correctly.
        neg = sqrt2().scale(-2, 1)
        self.assertEqual(neg.floor(), -3)
        self.assertEqual(neg.ceil(), -2)

    def test_scale_zero_and_bad_denominator(self):
        self.assertEqual(sqrt2().scale(0, 5).compare_to_rational(0), 0)
        with self.assertRaises(AlgebraicError):
            sqrt2().scale(1, 0)

    def test_scaled_budget_zero(self):
        self.assertEqual(sqrt2().scaled_round(7, 5, budget=0), 2)  # ~1.98


if __name__ == "__main__":
    unittest.main()
