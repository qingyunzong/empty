import unittest
from fractions import Fraction

from polygcd.bezout import extended_gcd_rational, verify_bezout
from polygcd.rational import to_rational


class TestBezout(unittest.TestCase):
    def test_valid_certificate(self):
        f = (2, -3, 1)  # (x-1)(x-2)
        g = (3, -4, 1)  # (x-1)(x-3)
        d, s, t = extended_gcd_rational(f, g)
        self.assertEqual(d, to_rational((-1, 1)))  # monic x - 1
        self.assertTrue(verify_bezout(f, g, s, t, d))

    def test_coprime_inputs(self):
        f = (1, 1)
        g = (1, -1)
        d, s, t = extended_gcd_rational(f, g)
        self.assertEqual(d, to_rational((1,)))
        self.assertTrue(verify_bezout(f, g, s, t, d))

    def test_zero_polynomial(self):
        d, s, t = extended_gcd_rational((), (2, -2))
        self.assertEqual(d, to_rational((-1, 1)))
        self.assertTrue(verify_bezout((), (2, -2), s, t, d))
        d0, s0, t0 = extended_gcd_rational((), ())
        self.assertEqual((d0, s0, t0), ((), (), ()))
        self.assertTrue(verify_bezout((), (), s0, t0, d0))

    def test_forged_certificates_rejected(self):
        f = (2, -3, 1)
        g = (3, -4, 1)
        d, s, t = extended_gcd_rational(f, g)
        self.assertTrue(verify_bezout(f, g, s, t, d))

        s_bad = list(s)
        s_bad[0] += 1
        self.assertFalse(verify_bezout(f, g, tuple(s_bad), t, d))

        t_bad = list(t)
        t_bad[0] += Fraction(1)
        self.assertFalse(verify_bezout(f, g, s, tuple(t_bad), d))

        d_bad = d + (Fraction(1),)  # x instead of x - 1
        self.assertFalse(verify_bezout(f, g, s, t, d_bad))

        d_scaled = tuple(2 * c for c in d)  # non-monic
        self.assertFalse(verify_bezout(f, g, s, t, d_scaled))

        # certificate replayed against different inputs
        self.assertFalse(verify_bezout((1, 0, 1), g, s, t, d))


if __name__ == "__main__":
    unittest.main()
