import unittest
from fractions import Fraction as F

from ridag.intervals import (Interval, MINF, PINF, mkset, sadd, ssub, smul,
                             sdiv, srecip, spow, sinter, sunion,
                             scontains_zero, all_positive, all_negative,
                             iv_subset, ssubset)


def iv(lo, hi, lc=True, hc=True):
    return Interval(F(lo), F(hi), lc, hc)


def S(*ivs):
    return mkset(list(ivs))


class TestIntervalOps(unittest.TestCase):
    def test_add_open_closed(self):
        r = sadd(S(iv(0, 1, False, True)), S(iv(0, 1, True, False)))
        self.assertEqual(r, S(iv(0, 2, False, False)))

    def test_add_infinite(self):
        r = sadd(S(Interval(F(1), PINF, True, False)),
                 S(Interval(MINF, F(0), False, True)))
        self.assertEqual(r, S(Interval(MINF, PINF, False, False)))

    def test_sub(self):
        r = ssub(S(iv(0, 1)), S(iv(2, 3)))
        self.assertEqual(r, S(iv(-3, -1)))

    def test_mul_exact(self):
        self.assertEqual(smul(S(iv(-1, 1)), S(iv(-1, 1))), S(iv(-1, 1)))
        self.assertEqual(smul(S(iv(0, 2, False, False)),
                              S(iv(0, 2, False, False))),
                         S(iv(0, 4, False, False)))
        self.assertEqual(smul(S(iv(0, 2)), S(iv(0, 2, False, True))),
                         S(iv(0, 4)))
        self.assertEqual(smul(S(iv(-3, -1)), S(iv(2, 4))), S(iv(-12, -2)))

    def test_mul_infinite(self):
        r = smul(S(Interval(F(2), PINF)), S(Interval(F(3), PINF)))
        self.assertEqual(r, S(Interval(F(6), PINF)))
        r = smul(S(Interval(MINF, F(-1), False, False)),
                 S(Interval(F(0), PINF, False, False)))
        self.assertEqual(r, S(Interval(MINF, F(0), False, False)))

    def test_division_splits_across_zero(self):
        # 1 / [-1, 1] must split into two rays, not the whole real line.
        r, hole = sdiv(S(iv(1, 1)), S(iv(-1, 1)))
        self.assertTrue(hole)
        self.assertEqual(r, S(Interval(MINF, F(-1), False, True),
                              Interval(F(1), PINF, True, False)))
        self.assertNotEqual(r, S(Interval(MINF, PINF)))
        self.assertFalse(scontains_zero(r))

    def test_division_open_at_zero(self):
        r, hole = sdiv(S(iv(1, 1)), S(iv(0, 2, False, True)))
        self.assertFalse(hole)
        self.assertEqual(r, S(Interval(F(1, 2), PINF, True, False)))

    def test_recip_finite(self):
        r, hole = srecip(S(iv(2, 4)))
        self.assertFalse(hole)
        self.assertEqual(r, S(iv(F(1, 4), F(1, 2))))

    def test_pow(self):
        self.assertEqual(spow(S(iv(-3, 2)), 2), (S(iv(0, 9)), False))
        self.assertEqual(spow(S(iv(-3, -1, False, False)), 2),
                         (S(iv(1, 9, False, False)), False))
        self.assertEqual(spow(S(iv(-2, 2)), 3), (S(iv(-8, 8)), False))
        self.assertEqual(spow(S(iv(0, 2, False, True)), 2),
                         (S(iv(0, 4, False, True)), False))
        r, hole = spow(S(iv(1, 2)), -1)
        self.assertEqual((r, hole), (S(iv(F(1, 2), F(1, 1))), False))
        r, hole = spow(S(iv(-2, -1)), -2)
        self.assertEqual((r, hole), (S(iv(F(1, 4), F(1, 1))), False))
        r, hole = spow(S(iv(-1, 1)), -2)
        self.assertTrue(hole)
        self.assertEqual(r, S(Interval(F(1), PINF, True, False)))

    def test_union_canonical(self):
        self.assertEqual(S(iv(0, 1, False, False), iv(1, 2, True, False)),
                         S(iv(0, 2, False, False)))
        self.assertEqual(len(S(iv(0, 1), iv(2, 3))), 2)
        self.assertEqual(S(iv(0, 2), iv(1, 3)), S(iv(0, 3)))

    def test_intersect(self):
        r = sinter(S(iv(0, 5, False, True)), S(iv(3, 7, True, False)))
        self.assertEqual(r, S(iv(3, 5, True, True)))
        r = sinter(S(iv(0, 1)), S(iv(2, 3)))
        self.assertEqual(r, ())

    def test_predicates(self):
        self.assertTrue(scontains_zero(S(iv(-1, 1))))
        self.assertFalse(scontains_zero(S(iv(0, 1, False, True))))
        self.assertTrue(all_positive(S(iv(0, 1, False, True))))
        self.assertTrue(all_negative(S(Interval(MINF, F(0), False, False))))
        self.assertFalse(all_positive(S(iv(-1, 2))))

    def test_subset(self):
        self.assertTrue(iv_subset(iv(0, 1, False, True), iv(0, 1)))
        self.assertFalse(iv_subset(iv(0, 1), iv(0, 1, False, True)))
        self.assertTrue(ssubset(S(iv(0, 1), iv(2, 3)), S(iv(-1, 4))))


if __name__ == "__main__":
    unittest.main()
