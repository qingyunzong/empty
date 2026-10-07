import unittest
from fractions import Fraction

from realroots import poly as P
from realroots.algebraic import AlgebraicNumber, compare
from realroots.isolate import isolate

from helpers import linear, poly_from_roots, poly_pow


def an_at(coeffs, target):
    """Build an AlgebraicNumber for the root of coeffs near target."""
    status, roots, _ = isolate(coeffs)
    assert status == "ok"
    target = Fraction(target)
    for r in roots:
        if r["kind"] == "point":
            if r["lo"] == target:
                return AlgebraicNumber.from_polynomial(coeffs, "point", target)
        elif r["lo"] < target < r["hi"]:
            return AlgebraicNumber.from_polynomial(
                coeffs, "interval", r["lo"], r["hi"])
    raise AssertionError(f"no root near {target}")


class TestSharedRationalRoots(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.f = poly_from_roots(1, 2, 5)   # roots 1, 2, 5
        cls.g = poly_from_roots(2, 3, 5)   # roots 2, 3, 5

    def test_equal_shared_roots(self):
        self.assertEqual(compare(an_at(self.f, 2), an_at(self.g, 2)), 0)
        self.assertEqual(compare(an_at(self.f, 5), an_at(self.g, 5)), 0)

    def test_ordering_distinct_roots(self):
        self.assertEqual(compare(an_at(self.f, 1), an_at(self.g, 2)), -1)
        self.assertEqual(compare(an_at(self.g, 3), an_at(self.f, 5)), -1)
        self.assertEqual(compare(an_at(self.f, 5), an_at(self.g, 3)), 1)
        self.assertEqual(compare(an_at(self.g, 2), an_at(self.f, 1)), 1)


class TestSharedIrrationalRoots(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.f = P.mul((Fraction(-2), Fraction(0), Fraction(1)), linear(1))
        cls.g = P.mul((Fraction(-2), Fraction(0), Fraction(1)), linear(7))

    def test_sqrt2_equal_across_polynomials(self):
        a = an_at(self.f, Fraction(1414, 1000))  # near sqrt(2)
        b = an_at(self.g, Fraction(1414, 1000))
        self.assertEqual(compare(a, b), 0)

    def test_sqrt2_ordered_against_other_roots(self):
        sqrt2_f = an_at(self.f, Fraction(1414, 1000))
        seven = an_at(self.g, 7)
        one = an_at(self.f, 1)
        self.assertEqual(compare(sqrt2_f, seven), -1)
        self.assertEqual(compare(one, an_at(self.g, Fraction(1414, 1000))), -1)
        self.assertEqual(compare(seven, sqrt2_f), 1)

    def test_negative_sqrt2_equal(self):
        a = an_at(self.f, Fraction(-1414, 1000))
        b = an_at(self.g, Fraction(-1414, 1000))
        self.assertEqual(compare(a, b), 0)


class TestPointsAndMultiplicity(unittest.TestCase):
    def test_point_vs_interval_equality(self):
        # (x-2)^3 has point root 2 with multiplicity 3
        f = poly_pow(linear(2), 3)
        g = poly_from_roots(2, 3)
        a = AlgebraicNumber.from_polynomial(f, "point", 2)
        b = an_at(g, 2)
        self.assertEqual(a.multiplicity, 3)
        self.assertEqual(b.multiplicity, 1)
        self.assertEqual(compare(a, b), 0)

    def test_point_vs_interval_order(self):
        f = poly_from_roots(2, 3)
        a = AlgebraicNumber.from_polynomial(linear(2), "point", 2)
        b = an_at(f, 3)
        self.assertEqual(compare(a, b), -1)
        self.assertEqual(compare(b, a), 1)

    def test_same_polynomial_same_root(self):
        a = an_at(poly_from_roots(4), 4)
        b = AlgebraicNumber.from_polynomial(linear(4), "point", 4)
        self.assertEqual(compare(a, b), 0)


class TestVeryCloseDistinctRoots(unittest.TestCase):
    def test_close_roots_of_different_polynomials(self):
        gap = Fraction(1, 2 ** 40)
        f = linear(1)
        g = linear(1 + gap)
        a = AlgebraicNumber.from_polynomial(f, "point", 1)
        b = AlgebraicNumber.from_polynomial(g, "point", 1 + gap)
        self.assertEqual(compare(a, b), -1)
        self.assertEqual(compare(b, a), 1)


if __name__ == "__main__":
    unittest.main()
