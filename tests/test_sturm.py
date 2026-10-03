import random
import unittest
from fractions import Fraction

from ridag.dag import DAG
from ridag.interval import End, Interval, IntervalUnion
from ridag.newton import Isolator, UNIQUE, NONE, UNDECIDED
from ridag.newton import _sturm_count_range
from ridag.cert import verify_certificate
from ridag.jsonio import cert_to_json
from ridag import poly as P


class TestSturmBasics(unittest.TestCase):
    def test_known_counts(self):
        # x^2 - 1: roots -1, 1
        p = [Fraction(-1), Fraction(0), Fraction(1)]
        self.assertEqual(P.sturm_count(p, None, None), 2)
        self.assertEqual(P.sturm_count(p, Fraction(0), None), 1)
        self.assertEqual(P.sturm_count(p, Fraction(-2), Fraction(0)), 1)
        self.assertEqual(P.sturm_count(p, Fraction(2), Fraction(5)), 0)

    def test_multiple_root_counted_once(self):
        # (x-1)^2 = x^2 - 2x + 1
        p = [Fraction(1), Fraction(-2), Fraction(1)]
        self.assertEqual(P.sturm_count(p, None, None), 1)

    def test_rational_roots_theorem(self):
        # 2x^2 - 1 has no rational roots; 6x^2 - x - 2 has 2/3, -1/2
        p = [Fraction(-1), Fraction(0), Fraction(2)]
        self.assertEqual(P.rational_roots(p), [])
        q = [Fraction(-2), Fraction(-1), Fraction(6)]
        self.assertEqual(P.rational_roots(q), [Fraction(-1, 2), Fraction(2, 3)])

    def test_poly_extraction(self):
        dag = DAG()
        x = dag.var("x")
        f = dag.div(dag.add(dag.pow(x, 2), dag.const(1)),
                    dag.sub(x, dag.const(2)))
        r = P.to_rational(f, "x")
        self.assertIsNotNone(r)
        num, den = r
        self.assertEqual(num, [Fraction(1), Fraction(0), Fraction(1)])
        self.assertEqual(den, [Fraction(-2), Fraction(1)])


class TestSturmCrossCheck(unittest.TestCase):
    """For random low-degree polynomials, the isolator's unique_root claims
    must (a) cover every real root and (b) match the independent Sturm count.
    """

    def test_random_polynomials(self):
        rng = random.Random(20261003)
        for trial in range(12):
            deg = rng.randint(1, 4)
            coeffs = [Fraction(rng.randint(-5, 5), rng.randint(1, 4))
                      for _ in range(deg + 1)]
            if coeffs[-1] == 0:
                coeffs[-1] = Fraction(1)
            dag = DAG()
            x = dag.var("x")
            f = dag.const(coeffs[0])
            for k, c in enumerate(coeffs[1:], start=1):
                f = dag.add(f, dag.mul(dag.const(c), dag.pow(x, k)))
            domain = IntervalUnion([Interval.closed(End(-4), End(4))])
            cert = Isolator(dag, f, "x", domain,
                            eps=Fraction(1, 10 ** 6)).isolate()
            ok, errors = verify_certificate(cert_to_json(cert))
            self.assertTrue(ok, errors)
            uniques = [c.interval for c in cert.claims if c.status == UNIQUE]
            self.assertFalse(any(c.status == UNDECIDED for c in cert.claims),
                             "trial %d: undecided left for %s" % (trial, coeffs))
            # independent Sturm count over the domain
            expect = _sturm_count_range(
                coeffs, Interval.closed(End(-4), End(4)))
            self.assertEqual(len(uniques), expect,
                             "trial %d coeffs %s" % (trial, coeffs))
            # every claimed interval contains a root of the polynomial:
            # verify by checking the Sturm count of each claim interval
            for iv in uniques:
                if iv.is_point():
                    self.assertEqual(P.peval(coeffs, iv.lo.val), 0)
                else:
                    lo = iv.lo.val
                    hi = iv.hi.val
                    self.assertEqual(P.sturm_count(coeffs, lo, hi), 1)


if __name__ == "__main__":
    unittest.main()
