import unittest
from fractions import Fraction

from interval_newton.solver import MultipleRootsError, solve


def poly_from_roots(roots):
    """Ascending coefficients of prod (x - r) for rational roots r."""
    p = [Fraction(1)]
    for r in roots:
        r = Fraction(r)
        q = [Fraction(0)] * (len(p) + 1)
        for i, c in enumerate(p):
            q[i] -= c * r
            q[i + 1] += c
        p = q
    return p


def desc(roots):
    """Descending-order coefficients of prod (x - r)."""
    return poly_from_roots(roots)[::-1]


def bisection_reference(coeffs_desc, a, b, eps, samples=4000):
    """Independent plain-bisection root finder used as a cross-check."""
    asc = [Fraction(c) for c in reversed(coeffs_desc)]

    def f(x):
        acc = Fraction(0)
        for c in reversed(asc):
            acc = acc * x + c
        return acc

    a, b = Fraction(a), Fraction(b)
    roots = []
    prev_x, prev_f = a, f(a)
    if prev_f == 0:
        roots.append(a)
    for i in range(1, samples + 1):
        x = a + (b - a) * i / samples
        fx = f(x)
        if fx == 0:
            roots.append(x)
        elif prev_f != 0 and fx * prev_f < 0:
            lo, hi, flo = prev_x, x, prev_f
            while hi - lo > eps:
                m = (lo + hi) / 2
                fm = f(m)
                if fm == 0:
                    lo = hi = m
                    break
                if flo * fm < 0:
                    hi = m
                else:
                    lo, flo = m, fm
            roots.append((lo + hi) / 2)
        prev_x, prev_f = x, fx
    return roots


class CompareWithBisectionTest(unittest.TestCase):
    """(a) Root positions must agree with a plain bisection reference."""

    def check_against_reference(self, coeffs_desc, a, b, eps):
        got = solve(coeffs_desc, a, b, eps)
        ref = bisection_reference(coeffs_desc, a, b, eps / 8)
        self.assertEqual(len(got), len(ref),
                         f"{coeffs_desc}: {got} vs reference {ref}")
        for (lo, hi), r in zip(got, ref):
            self.assertLess(hi - lo, eps)
            self.assertLessEqual(lo, r + eps)
            self.assertLessEqual(r - eps, hi)

    def test_quadratic_irrational_roots(self):
        self.check_against_reference([1, 0, -2], 0, 2, Fraction(1, 10**6))

    def test_cubic_three_real_roots(self):
        self.check_against_reference([1, 0, -3, 1], -2, 2, Fraction(1, 10**8))

    def test_quartic_four_roots(self):
        self.check_against_reference([1, 0, -5, 0, 4], -3, 3, Fraction(1, 10**6))

    def test_cubic_one_real_root(self):
        self.check_against_reference([1, 0, -1, -1], -2, 2, Fraction(1, 10**6))


class KnownRationalRootsTest(unittest.TestCase):
    """(b) Product polynomial with known distinct rational roots."""

    def test_all_rational_roots_found(self):
        roots = [-2, Fraction(-3, 7), 0, Fraction(1, 2), 5]
        eps = Fraction(1, 10**6)
        got = solve(desc(roots), -3, 6, eps)
        self.assertEqual(len(got), len(roots))
        for r in roots:
            matches = [e for e in got if e[0] <= r <= e[1]]
            self.assertEqual(len(matches), 1, f"root {r} matched {len(matches)} of {len(got)} enclosures")
        for lo, hi in got:
            self.assertLess(hi - lo, eps)
        for (lo1, hi1), (lo2, hi2) in zip(got, got[1:]):
            self.assertLess(hi1, lo2)  # pairwise disjoint enclosures

    def test_close_roots_still_separated(self):
        roots = [1, Fraction(1001, 1000)]
        eps = Fraction(1, 10)
        got = solve(desc(roots), 0, 2, eps)
        self.assertEqual(len(got), 2)
        for (lo, hi), r in zip(got, roots):
            self.assertLess(hi - lo, eps)
            self.assertLessEqual(lo, r)
            self.assertLessEqual(r, hi)
        self.assertLess(got[0][1], got[1][0])

    def test_root_at_interval_endpoints(self):
        eps = Fraction(1, 100)
        self.assertEqual(solve([1, -1], 1, 5, eps), [(Fraction(1), Fraction(1))])
        self.assertEqual(solve([1, -2], 0, 2, eps), [(Fraction(2), Fraction(2))])

    def test_root_hit_exactly_at_midpoint(self):
        got = solve([2, -1], 0, 1, Fraction(1, 100))  # 2x - 1
        self.assertEqual(got, [(Fraction(1, 2), Fraction(1, 2))])


class NoRootAndMultipleRootTest(unittest.TestCase):
    """(c) Empty intervals for root-free ranges; exit-4 failures for multiples."""

    def test_no_real_roots_at_all(self):
        self.assertEqual(solve([1, 0, 1], -2, 2, Fraction(1, 1000)), [])
        self.assertEqual(solve([1, 2, 5], -10, 10, Fraction(1, 1000)), [])

    def test_roots_only_outside_interval(self):
        self.assertEqual(solve([1, -5], 0, 3, Fraction(1, 1000)), [])
        self.assertEqual(solve([1, 0, -2], 2, 3, Fraction(1, 1000)), [])

    def test_multiple_root_raises(self):
        with self.assertRaises(MultipleRootsError):
            solve([1, -2, 1], 0, 2, Fraction(1, 100))  # (x-1)^2

    def test_multiple_complex_root_raises(self):
        with self.assertRaises(MultipleRootsError):
            solve([1, 0, 2, 0, 1], -1, 1, Fraction(1, 100))  # (x^2+1)^2

    def test_zero_polynomial_raises(self):
        with self.assertRaises(MultipleRootsError):
            solve([0, 0, 0], 0, 1, Fraction(1, 100))

    def test_constant_polynomial_has_no_roots(self):
        self.assertEqual(solve([7], -1, 1, Fraction(1, 100)), [])


class TinyEpsTest(unittest.TestCase):
    """(d) Exact convergence with eps = 10^-30."""

    def test_irrational_root_tiny_eps(self):
        eps = Fraction(1, 10**30)
        got = solve([1, 0, -2], 1, 2, eps)
        self.assertEqual(len(got), 1)
        lo, hi = got[0]
        self.assertLess(hi - lo, eps)
        self.assertLess(lo * lo, 2)   # exact: lo < sqrt(2)
        self.assertGreater(hi * hi, 2)

    def test_rational_root_tiny_eps(self):
        eps = Fraction(1, 10**30)
        got = solve([3, -1], 0, 1, eps)  # 3x - 1
        self.assertEqual(got, [(Fraction(1, 3), Fraction(1, 3))])

    def test_product_polynomial_tiny_eps(self):
        roots = [Fraction(-7, 3), Fraction(11, 8)]
        eps = Fraction(1, 10**30)
        got = solve(desc(roots), -3, 2, eps)
        self.assertEqual(len(got), 2)
        for (lo, hi), r in zip(got, roots):
            self.assertLess(hi - lo, eps)
            self.assertLessEqual(lo, r)
            self.assertLessEqual(r, hi)


if __name__ == "__main__":
    unittest.main()
