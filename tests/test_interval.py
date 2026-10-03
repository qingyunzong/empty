import unittest
from fractions import Fraction

from ridag.interval import End, Interval, IntervalUnion, NEG_INF, POS_INF, ZERO


class TestEnd(unittest.TestCase):
    def test_exact_rational(self):
        e = End(Fraction(1, 3))
        self.assertEqual(e.val, Fraction(1, 3))
        self.assertFalse(e.is_inf)

    def test_infinity_ordering(self):
        self.assertLess(NEG_INF, End(Fraction(-10**30)))
        self.assertLess(End(Fraction(10**30)), POS_INF)
        self.assertEqual(POS_INF, End.inf(1))

    def test_inf_arithmetic(self):
        self.assertEqual((POS_INF + End(5)), POS_INF)
        self.assertEqual(-POS_INF, NEG_INF)
        self.assertEqual(POS_INF * End(-2), NEG_INF)
        with self.assertRaises(ArithmeticError):
            POS_INF * ZERO


class TestInterval(unittest.TestCase):
    def test_open_closed(self):
        i = Interval(End(0), True, End(1), False)
        self.assertFalse(i.contains_end(ZERO))
        self.assertTrue(i.contains_end(End(1)))
        self.assertTrue(i.excludes_zero())
        j = Interval(End(0), False, End(1), False)
        self.assertTrue(j.contains_zero())

    def test_empty_rejected(self):
        self.assertIsNone(Interval.of(End(1), False, End(0), False))
        self.assertIsNone(Interval.of(End(1), True, End(1), True))
        self.assertIsNotNone(Interval.of(End(1), False, End(1), False))

    def test_add_sub_exact(self):
        a = Interval.closed(End(Fraction(1, 3)), End(Fraction(1, 2)))
        b = Interval.closed(End(Fraction(1, 6)), End(Fraction(1, 4)))
        s = a + b
        self.assertEqual(s.lo.val, Fraction(1, 2))
        self.assertEqual(s.hi.val, Fraction(3, 4))
        d = a - b
        self.assertEqual(d.lo.val, Fraction(1, 12))
        self.assertEqual(d.hi.val, Fraction(1, 3))

    def test_mul_signs_and_openness(self):
        a = Interval(End(-2), False, End(3), False)
        b = Interval(End(-1), False, End(4), False)
        p = a * b
        self.assertEqual((p.lo.val, p.hi.val), (-8, 12))
        # (0,1] * (0,1] = (0,1]
        c = Interval(End(0), True, End(1), False)
        p2 = c * c
        self.assertEqual((p2.lo.val, p2.lo_open, p2.hi.val), (Fraction(0), True, Fraction(1)))
        # {0} * (0, +inf) = {0}
        z = Interval.point(ZERO)
        u = Interval(End(0), True, POS_INF, True)
        p3 = z * u
        self.assertTrue(p3.is_point() and p3.lo.is_zero() and not p3.lo_open)

    def test_mul_with_infinity(self):
        a = Interval.closed(End(0), End(1))
        b = Interval(End(2), False, POS_INF, True)
        p = a * b
        self.assertEqual(p.lo.val, 0)
        self.assertTrue(p.hi.is_inf)

    def test_division_splits_across_zero(self):
        num = Interval.point(End(1))
        den = Interval.closed(End(-1), End(2))
        u = IntervalUnion([num]) / IntervalUnion([den])
        # must be two rays, never the whole real line
        self.assertEqual(len(u.intervals), 2)
        neg, pos = u.intervals
        self.assertTrue(neg.hi.is_inf is False)
        self.assertEqual(neg.hi.val, Fraction(-1))
        self.assertTrue(neg.lo.is_inf)
        self.assertEqual(pos.lo.val, Fraction(1, 2))
        self.assertTrue(pos.hi.is_inf)
        self.assertFalse(u.contains_zero())

    def test_division_open_at_zero(self):
        num = Interval.point(End(2))
        den = Interval(End(0), True, End(4), False)  # (0,4]
        u = IntervalUnion([num]) / IntervalUnion([den])
        self.assertEqual(len(u.intervals), 1)
        i = u.intervals[0]
        self.assertEqual(i.lo.val, Fraction(1, 2))
        self.assertTrue(i.hi.is_inf)

    def test_pow_int(self):
        i = Interval.closed(End(-2), End(3))
        self.assertEqual(i.pow_int(2).as_interval().lo.val, 0)
        self.assertEqual(i.pow_int(2).as_interval().hi.val, 9)
        self.assertEqual(i.pow_int(3).as_interval().lo.val, -8)
        self.assertEqual(i.pow_int(3).as_interval().hi.val, 27)
        # negative power across 0 splits into two rays
        u = Interval.closed(End(-1), End(2)).pow_int(-1)
        self.assertEqual(len(u.intervals), 2)

    def test_intersect_subset(self):
        a = Interval(End(0), True, End(5), False)
        b = Interval.closed(End(3), End(7))
        inter = a.intersect(b)
        self.assertEqual((inter.lo.val, inter.lo_open, inter.hi.val, inter.hi_open),
                         (Fraction(3), False, Fraction(5), False))
        self.assertTrue(Interval.point(End(4)).subset_of(a))
        self.assertFalse(Interval.point(End(0)).subset_of(a))


class TestUnion(unittest.TestCase):
    def test_canonical_merge(self):
        u = IntervalUnion([
            Interval.closed(End(0), End(1)),
            Interval(End(1), True, End(2), False),
        ])
        self.assertEqual(len(u), 1)  # touching pieces merge

    def test_hole_preserved(self):
        u = IntervalUnion([
            Interval(End(0), True, End(1), True),
            Interval(End(1), True, End(2), True),
        ])
        self.assertEqual(len(u), 2)  # hole at 1 is structural
        self.assertFalse(u.contains_end(End(1)))

    def test_no_collapse_to_reals(self):
        u = IntervalUnion([
            Interval(NEG_INF, True, End(0), True),
            Interval(End(0), True, POS_INF, True),
        ])
        self.assertEqual(len(u), 2)
        self.assertFalse(u.contains_zero())

    def test_union_arithmetic_lifted(self):
        u = IntervalUnion([Interval.point(End(1)), Interval.point(End(2))])
        v = u + u
        vals = sorted(i.lo.val for i in v.intervals)
        self.assertEqual(vals, [2, 3, 4])

    def test_covers(self):
        a = IntervalUnion([Interval.closed(End(0), End(10))])
        b = IntervalUnion([Interval.closed(End(0), End(5)),
                           Interval(End(5), True, End(9), False)])
        self.assertTrue(a.covers(b))
        self.assertFalse(b.covers(a))


if __name__ == "__main__":
    unittest.main()
