import unittest
from fractions import Fraction

from polygcd.modular import mod_poly, gcd_mod_p, crt_pair, crt_polys
from polygcd.rational import rational_reconstruct


class TestModGcd(unittest.TestCase):
    def test_shared_factor(self):
        # x^2 - 1 and (x-1)(x-2) share exactly (x-1) over GF(7)
        self.assertEqual(gcd_mod_p((-1, 0, 1), (2, -3, 1), 7), (6, 1))

    def test_coprime(self):
        self.assertEqual(gcd_mod_p((1, 1), (1, -1), 5), (1,))

    def test_mod_poly(self):
        self.assertEqual(mod_poly((8, -1, 14), 7), (1, 6))
        self.assertEqual(mod_poly((7, 14), 7), ())


class TestCrt(unittest.TestCase):
    def test_crt_pair(self):
        x = crt_pair(3, 7, 1, 5)
        self.assertEqual(x % 7, 3)
        self.assertEqual(x % 5, 1)
        self.assertLess(x, 35)

    def test_crt_polys_roundtrip(self):
        p = (123456789, -987654321, 42)
        primes = [11, 13, 17, 19]
        residues = [mod_poly(p, q) for q in primes]
        combined, modulus = crt_polys(residues, primes)
        self.assertEqual(modulus, 11 * 13 * 17 * 19)
        for c, r in zip(p, combined):
            self.assertEqual((c - r) % modulus, 0)


class TestRationalReconstruct(unittest.TestCase):
    def test_roundtrip(self):
        m = 11 * 13 * 17 * 19 * 23 * 29
        for frac in (Fraction(3, 7), Fraction(-5, 3), Fraction(0), Fraction(11, 8)):
            if frac:
                a = frac.numerator * pow(frac.denominator, -1, m) % m
            else:
                a = 0
            self.assertEqual(rational_reconstruct(a, m), frac)

    def test_failure_when_bound_too_small(self):
        # 2 == -1/2 (mod 5) but denominator 2 exceeds sqrt(5/2) -> rejected
        self.assertIsNone(rational_reconstruct(2, 5))


if __name__ == "__main__":
    unittest.main()
