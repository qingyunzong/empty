import unittest

from polygcd.polynomial import (
    trim,
    degree,
    lc,
    add,
    sub,
    mul,
    mul_scalar,
    content,
    primitive_part,
    content_pp,
    exact_div,
)


class TestBasics(unittest.TestCase):
    def test_trim_and_degree(self):
        self.assertEqual(trim((1, 2, 0, 0)), (1, 2))
        self.assertEqual(trim((0, 0)), ())
        self.assertEqual(degree(()), -1)
        self.assertEqual(degree((5,)), 0)
        self.assertEqual(lc((3, -7, 9)), 9)

    def test_arithmetic(self):
        a = (1, 2, 3)
        b = (3, -1)
        self.assertEqual(add(a, b), (4, 1, 3))
        self.assertEqual(sub(a, b), (-2, 3, 3))
        self.assertEqual(mul((1, 1), (1, 1)), (1, 2, 1))
        self.assertEqual(mul(a, ()), ())
        self.assertEqual(mul_scalar(a, 0), ())
        self.assertEqual(mul_scalar(a, -2), (-2, -4, -6))

    def test_exact_div(self):
        self.assertEqual(exact_div((1, 2, 1), (1, 1)), (1, 1))
        self.assertIsNone(exact_div((1, 2, 2), (1, 1)))
        self.assertEqual(exact_div((), (1, 1)), ())
        self.assertIsNone(exact_div((1, 1), (1, 1, 1)))
        self.assertEqual(exact_div((-6, -1, -6, 4, 3), (-3, 1, 1)), (2, 1, 3))
        with self.assertRaises(ZeroDivisionError):
            exact_div((1,), ())


class TestContentPrimitivePart(unittest.TestCase):
    def test_large_common_content(self):
        big = 2**80 * 3**40 * 5**30
        p = tuple(big * c for c in (6, -9, 3))
        c, pp = content_pp(p)
        self.assertEqual(c, 3 * big)
        self.assertEqual(pp, (2, -3, 1))
        self.assertEqual(tuple(c * x for x in pp), p)

    def test_sign_normalization(self):
        self.assertEqual(primitive_part((-2, 4, -6)), (1, -2, 3))
        self.assertEqual(primitive_part((2, -4, 6)), (1, -2, 3))
        self.assertEqual(primitive_part(()), ())
        self.assertEqual(content(()), 0)
        self.assertEqual(content((0, 0, 0)), 0)


if __name__ == "__main__":
    unittest.main()
