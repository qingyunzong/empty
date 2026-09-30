import unittest

from polygcd import poly


class TestContentPrimitive(unittest.TestCase):
    def test_content_with_huge_common_factor(self):
        big = (2 ** 120) * (3 ** 40) * (10 ** 30 + 7)
        f = [big * 6, -big * 10, big * 14]
        self.assertEqual(poly.content(f), big * 2)
        self.assertEqual(poly.primitive_part(f), [3, -5, 7])

    def test_primitive_part_normalizes_sign(self):
        self.assertEqual(poly.primitive_part([-4, -8, -12]), [1, 2, 3])
        self.assertEqual(poly.primitive_part([4, 8, 12]), [1, 2, 3])

    def test_zero_polynomial(self):
        self.assertEqual(poly.content([]), 0)
        self.assertEqual(poly.primitive_part([]), [])
        self.assertEqual(poly.degree([]), -1)

    def test_exact_division_zz(self):
        d = [3, -2, 5]
        q = [7, 0, 1, -4]
        f = poly.mul(d, q)
        self.assertEqual(poly.div_exact_zz(f, d), q)
        bad = list(f)
        bad[0] += 1
        self.assertIsNone(poly.div_exact_zz(bad, d))

    def test_divmod_qq(self):
        q, r = poly.divmod_qq(poly.to_qq([1, 2, 3]), poly.to_qq([1, 1]))
        self.assertTrue(poly.eq(poly.add(poly.mul(q, poly.to_qq([1, 1])), r),
                                poly.to_qq([1, 2, 3])))


if __name__ == "__main__":
    unittest.main()
