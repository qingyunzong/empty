import unittest
from fractions import Fraction as F

from ridag.intervals import Interval, mkset
from ridag.expr import Ctx, Env
from ridag.isolate import isolate, UNIQUE, NONE, UNDECIDED
from ridag import sturm, certcheck


def S(*ivs):
    return mkset(list(ivs))


def iv(lo, hi, lc=True, hc=True):
    return Interval(F(lo), F(hi), lc, hc)


def poly_expr(c, x, coeffs):
    # Horner form, sharing the variable node
    acc = c.const(coeffs[-1])
    for coef in reversed(coeffs[:-1]):
        acc = c.add(c.mul(acc, x), c.const(coef))
    return acc


def expand(factors):
    # factors: list of (a, b) meaning (a*x + b); returns coeff list
    p = [F(1)]
    for a, b in factors:
        q = [F(0)] * (len(p) + 1)
        for i, c0 in enumerate(p):
            q[i] += c0 * b
            q[i + 1] += c0 * a
        p = q
    return p


class TestSturm(unittest.TestCase):
    def test_sturm_counts(self):
        p = expand([(1, -1), (1, -2), (1, -3)])  # roots 1, 2, 3
        self.assertEqual(sturm.count_roots(p), 3)
        self.assertEqual(sturm.count_roots(p, F(0), F(2)), 2)   # (0, 2]
        self.assertEqual(sturm.count_roots(p, F(1), F(2)), 1)   # (1, 2]
        self.assertEqual(sturm.count_roots(p, F(5), F(10)), 0)

    def test_sturm_multiple_root_counted_once(self):
        p = expand([(1, -1), (1, -1), (1, 2)])  # roots 1 (double), -2
        self.assertEqual(sturm.count_roots(p), 2)

    def cross_check(self, coeffs, dom, budget=20000):
        c = Ctx()
        x = c.var("x")
        env = Env(c)
        env.set_var("x", S(dom))
        f = poly_expr(c, x, coeffs)
        outs = isolate(c, env, f, "x", S(dom), budget=budget)
        certcheck.verify(c, f, "x", S(dom), outs)
        total = sturm.roots_in_interval(coeffs, dom)
        by_label = {UNIQUE: 0, NONE: 0, UNDECIDED: 0}
        for o in outs:
            n = sturm.roots_in_interval(coeffs, o.interval)
            if o.label == UNIQUE:
                self.assertEqual(n, 1, "unique interval without 1 root")
            if o.label == NONE:
                self.assertEqual(n, 0, "none interval with a root")
            by_label[o.label] += n
        self.assertEqual(sum(by_label.values()), total,
                         "root coverage mismatch vs Sturm count")
        return outs

    def test_cross_check_distinct_rational_roots(self):
        # (2x-1)(3x+2)(x-4): roots 1/2, -2/3, 4
        coeffs = expand([(2, -1), (3, 2), (1, -4)])
        outs = self.cross_check(coeffs, iv(-8, 8))
        self.assertFalse(any(o.label == UNDECIDED for o in outs))

    def test_cross_check_irrational_roots(self):
        # x^3 - 2x: roots 0, +/-sqrt(2)
        coeffs = [F(0), F(-2), F(0), F(1)]
        outs = self.cross_check(coeffs, iv(-8, 8))
        self.assertFalse(any(o.label == UNDECIDED for o in outs))

    def test_cross_check_multiple_root(self):
        # (x-1)^2 (x+2): distinct roots 1, -2
        coeffs = expand([(1, -1), (1, -1), (1, 2)])
        self.cross_check(coeffs, iv(-8, 8), budget=3000)

    def test_cross_check_tiny_coefficients(self):
        # (10^9 x - 1)(x - 3): roots 1/10^9, 3
        coeffs = expand([(10 ** 9, -1), (1, -3)])
        outs = self.cross_check(coeffs, iv(-1, 5))
        self.assertFalse(any(o.label == UNDECIDED for o in outs))


if __name__ == "__main__":
    unittest.main()
