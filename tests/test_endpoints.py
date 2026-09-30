import unittest
from fractions import Fraction

from intervalmap.endpoints import (
    NEG_INF, POS_INF, parse_endpoint, format_endpoint, sort_key,
)


class TestEndpoints(unittest.TestCase):
    def test_parse_rationals(self):
        self.assertEqual(parse_endpoint("3/4"), Fraction(3, 4))
        self.assertEqual(parse_endpoint("5"), Fraction(5))
        self.assertEqual(parse_endpoint(7), Fraction(7))
        self.assertEqual(parse_endpoint("-2/3"), Fraction(-2, 3))
        self.assertEqual(parse_endpoint("0.5"), Fraction(1, 2))

    def test_parse_infinity(self):
        self.assertIs(parse_endpoint("+inf"), POS_INF)
        self.assertIs(parse_endpoint("inf"), POS_INF)
        self.assertIs(parse_endpoint("-inf"), NEG_INF)

    def test_invalid(self):
        for bad in ("abc", "1/0", None, True, object()):
            with self.assertRaises((ValueError, TypeError)):
                parse_endpoint(bad)

    def test_ordering_with_infinity(self):
        self.assertTrue(NEG_INF < Fraction(-10**9))
        self.assertTrue(Fraction(10**9) < POS_INF)
        self.assertTrue(NEG_INF < POS_INF)
        self.assertEqual(POS_INF, parse_endpoint("+inf"))
        self.assertFalse(POS_INF < POS_INF)

    def test_arithmetic_with_infinity(self):
        self.assertIs(POS_INF - Fraction(3), POS_INF)
        self.assertIs(Fraction(3) - NEG_INF, POS_INF)
        self.assertIs(POS_INF - NEG_INF, POS_INF)
        self.assertIs(POS_INF + Fraction(1), POS_INF)
        with self.assertRaises(ArithmeticError):
            POS_INF - POS_INF

    def test_format_roundtrip(self):
        for text in ("0", "3", "-2", "3/4", "-7/8", "+inf", "-inf"):
            self.assertEqual(format_endpoint(parse_endpoint(text)), text)

    def test_sort_key(self):
        eps = [POS_INF, Fraction(2), NEG_INF, Fraction(-1)]
        self.assertEqual(sorted(eps, key=sort_key),
                         [NEG_INF, Fraction(-1), Fraction(2), POS_INF])


if __name__ == "__main__":
    unittest.main()
