import unittest
from fractions import Fraction

from realroots import poly as P
from realroots.sturm import (count_roots_open, sturm_sequence,
                             total_real_roots)

from helpers import linear, poly_from_roots, poly_pow


class TestPolyArithmetic(unittest.TestCase):
    def test_mul_divmod_exact(self):
        a = poly_from_roots(1, 2, 3)          # (x-1)(x-2)(x-3)
        b = linear(2)                          # x-2
        q, r = P.divmod_poly(a, b)
        self.assertEqual(r, ())
        self.assertEqual(q, poly_from_roots(1, 3))

    def test_gcd_monic(self):
        a = poly_from_roots(1, 2, 2, 3)
        b = poly_from_roots(2, 4)
        self.assertEqual(P.gcd(a, b), linear(2))

    def test_evaluate(self):
        f = (Fraction(-2), Fraction(0), Fraction(1))  # x^2 - 2
        self.assertEqual(P.evaluate(f, 2), 2)
        self.assertEqual(P.evaluate(f, Fraction(3, 2)), Fraction(1, 4))


class TestSquarefree(unittest.TestCase):
    def test_high_multiplicity(self):
        f = P.mul(poly_pow(linear(1), 4),
                  P.mul(poly_pow(linear(-2), 3), linear(3)))
        leading, facs = P.squarefree_factors(f)
        self.assertEqual(leading, 1)
        by_mult = {m: fa for fa, m in facs}
        self.assertEqual(by_mult[4], linear(1))
        self.assertEqual(by_mult[3], linear(-2))
        self.assertEqual(by_mult[1], linear(3))

    def test_product_reconstructs(self):
        f = P.scale(P.mul(poly_pow(linear(5), 2), poly_pow(linear(-7), 5)),
                    Fraction(9, 4))
        leading, facs = P.squarefree_factors(f)
        self.assertEqual(leading, Fraction(9, 4))
        product = (leading,)
        for fa, m in facs:
            product = P.mul(product, P.pow_poly(fa, m))
        self.assertEqual(product, f)

    def test_squarefree_input(self):
        f = poly_from_roots(0, 1, 2)
        _, facs = P.squarefree_factors(f)
        self.assertEqual(facs, [(P.monic(f), 1)])

    def test_constant(self):
        leading, facs = P.squarefree_factors((Fraction(6),))
        self.assertEqual((leading, facs), (Fraction(6), []))

    def test_zero_polynomial_rejected(self):
        with self.assertRaises(ValueError):
            P.squarefree_factors(())


class TestSturm(unittest.TestCase):
    def test_counts_cubic(self):
        f = (Fraction(0), Fraction(-1), Fraction(0), Fraction(1))  # x^3-x
        seq = sturm_sequence(f)
        self.assertEqual(total_real_roots(seq), 3)
        self.assertEqual(count_roots_open(seq, f, 0, 2), 1)   # root 1
        self.assertEqual(count_roots_open(seq, f, -2, 0), 1)  # root -1
        self.assertEqual(count_roots_open(seq, f, 5, 9), 0)

    def test_open_interval_excludes_endpoint_root(self):
        f = P.mul(linear(1), linear(2))
        seq = sturm_sequence(f)
        # root exactly at hi=1 must not be counted in the open interval
        self.assertEqual(count_roots_open(seq, f, 0, 1), 0)
        self.assertEqual(count_roots_open(seq, f, 0, 3), 2)

    def test_no_real_roots(self):
        f = (Fraction(1), Fraction(0), Fraction(1))  # x^2 + 1
        seq = sturm_sequence(f)
        self.assertEqual(total_real_roots(seq), 0)


if __name__ == "__main__":
    unittest.main()
