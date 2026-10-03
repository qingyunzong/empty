import unittest
from fractions import Fraction

from algroots.poly import Poly, parse_rational


class TestPoly(unittest.TestCase):
    def test_arithmetic(self):
        p = Poly([-1, 0, 1])          # x^2 - 1
        q = Poly([1, 1])              # x + 1
        self.assertEqual(p + q, Poly([0, 1, 1]))
        self.assertEqual(p - q, Poly([-2, -1, 1]))
        self.assertEqual(p * q, Poly([-1, -1, 1, 1]))
        self.assertEqual((p * q) // q, p)
        self.assertEqual((p * q) % q, Poly())

    def test_divmod_exact(self):
        p = Poly([2, -3, 0, 5])
        q = Poly([-1, 2])
        quo, rem = p.divmod(q)
        self.assertEqual(quo * q + rem, p)
        self.assertLess(rem.degree, q.degree)

    def test_gcd(self):
        a = Poly([-1, 1]) ** 2 * Poly([-2, 1])       # (x-1)^2 (x-2)
        b = Poly([-1, 1]) * Poly([-3, 1])            # (x-1)(x-3)
        self.assertEqual(a.gcd(b), Poly([-1, 1]))    # monic (x-1)

    def test_derivative_evaluate(self):
        p = Poly([1, 2, 3])           # 1 + 2x + 3x^2
        self.assertEqual(p.derivative(), Poly([2, 6]))
        self.assertEqual(p.evaluate(Fraction(1, 2)), Fraction(11, 4))
        self.assertEqual(p.sign_at(Fraction(1, 2)), 1)

    def test_squarefree_factorization(self):
        f = (Poly([-1, 1]) ** 3) * (Poly([2, 1]) ** 2) * Poly([1, 0, 1])
        content, factors = f.squarefree_factorization()
        by_mult = {m: fac for fac, m in factors}
        self.assertEqual(by_mult[3], Poly([-1, 1]))
        self.assertEqual(by_mult[2], Poly([2, 1]))
        self.assertEqual(by_mult[1], Poly([1, 0, 1]))
        product = Poly([content])
        for fac, m in factors:
            product = product * fac ** m
        self.assertEqual(product, f)

    def test_squarefree_constant(self):
        content, factors = Poly([7]).squarefree_factorization()
        self.assertEqual(content, 7)
        self.assertEqual(factors, [])

    def test_huge_coefficients(self):
        big = 10 ** 60
        p = Poly([big, -big, 1])
        q = Poly([-big, 1])
        quo, rem = p.divmod(q)
        self.assertEqual(quo * q + rem, p)
        self.assertEqual(p.evaluate(big), big)  # big^2 - big*big + big

    def test_parse_rational(self):
        self.assertEqual(parse_rational("3/4"), Fraction(3, 4))
        self.assertEqual(parse_rational("-5"), Fraction(-5))
        self.assertEqual(parse_rational(6), Fraction(6))
        with self.assertRaises(TypeError):
            parse_rational(1.5)  # floats rejected: exactness only

    def test_json_roundtrip(self):
        p = Poly([Fraction(1, 3), -5, Fraction(7, 2)])
        self.assertEqual(Poly.from_json(p.to_json()), p)


if __name__ == "__main__":
    unittest.main()
