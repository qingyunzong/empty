import unittest
from fractions import Fraction

from ridag.dag import DAG
from ridag.interval import End, Interval, IntervalUnion
from ridag.newton import Isolator, UNIQUE, NONE, UNDECIDED
from ridag.cert import verify_certificate
from ridag.jsonio import cert_to_json


def dom(lo, hi, lo_open=False, hi_open=False):
    return IntervalUnion([Interval(End(lo), lo_open, End(hi), hi_open)])


def isolate(f, dag, domain, **kw):
    kw.setdefault("eps", Fraction(1, 10 ** 12))
    cert = Isolator(dag, f, "x", domain, **kw).isolate()
    ok, errors = verify_certificate(cert_to_json(cert))
    assert ok, errors
    return cert


class TestKnownRoots(unittest.TestCase):
    def setUp(self):
        self.dag = DAG()
        self.x = self.dag.var("x")

    def unique_intervals(self, cert):
        return [c.interval for c in cert.claims if c.status == UNIQUE]

    def test_simple_rational_roots(self):
        # (x - 1/3)(x - 2): roots 1/3 and 2
        f = self.dag.mul(self.dag.sub(self.x, self.dag.const(Fraction(1, 3))),
                         self.dag.sub(self.x, 2))
        cert = isolate(f, self.dag, dom(-10, 10))
        roots = self.unique_intervals(cert)
        self.assertEqual(len(roots), 2)
        joined = IntervalUnion(roots)
        self.assertTrue(joined.contains_end(End(Fraction(1, 3))))
        self.assertTrue(joined.contains_end(End(2)))
        self.assertFalse(any(c.status == UNDECIDED for c in cert.claims))

    def test_root_hit_exactly_by_bisection(self):
        # root at dyadic 1/2 is found as an exact point
        f = self.dag.sub(self.dag.mul(self.x, self.x), self.dag.const(Fraction(1, 4)))
        cert = isolate(f, self.dag, dom(-1, 1))
        points = [i for i in self.unique_intervals(cert) if i.is_point()]
        vals = sorted(i.lo.val for i in points)
        self.assertEqual(vals, [Fraction(-1, 2), Fraction(1, 2)])

    def test_multiple_root(self):
        # (x-1)^2: double root at 1, no sign change anywhere
        f = self.dag.pow(self.dag.sub(self.x, 1), 2)
        cert = isolate(f, self.dag, dom(-2, 4))
        roots = self.unique_intervals(cert)
        self.assertEqual(len(roots), 1)
        self.assertTrue(IntervalUnion(roots).contains_end(End(1)))
        self.assertFalse(any(c.status == UNDECIDED for c in cert.claims))

    def test_cancellation_dependency(self):
        # x - x is exactly zero on any interval: no over-estimation
        f = self.dag.sub(self.x, self.x)
        cert = Isolator(self.dag, f, "x", dom(-5, 5),
                        eps=Fraction(1, 100)).isolate()
        # identically zero: every point is a root -> reported undecided/zero
        kinds = {c.evidence.get("reason") for c in cert.claims}
        self.assertIn("identically zero", kinds)

    def test_shared_subexpression_overestimate_bounded(self):
        # x*(x-1) - x*x + x  == 0 after simplification? build it raw:
        x = self.x
        f = self.dag.add(self.dag.sub(self.dag.mul(x, self.dag.sub(x, self.dag.const(1))),
                                      self.dag.pow(x, 2)), x)
        # DAG simplification cannot see through mul/pow, but the expression
        # is identically zero; the isolator must stay sound (no fake roots).
        cert = Isolator(self.dag, f, "x", dom(-3, 3),
                        eps=Fraction(1, 10 ** 6), budget=2000).isolate()
        for c in cert.claims:
            if c.status == UNIQUE:
                self.fail("phantom unique root reported for zero function")

    def test_root_at_open_endpoint_excluded(self):
        # root at 0, but the domain is (0, 2]: no root inside
        f = self.dag.sub(self.x, self.dag.const(0))
        cert = isolate(f, self.dag, dom(0, 2, lo_open=True))
        self.assertFalse(any(c.status == UNIQUE for c in cert.claims))
        self.assertFalse(any(c.status == UNDECIDED for c in cert.claims))

    def test_root_at_closed_endpoint_found(self):
        f = self.dag.sub(self.x, self.dag.const(0))
        cert = isolate(f, self.dag, dom(0, 2))
        roots = self.unique_intervals(cert)
        self.assertEqual(len(roots), 1)
        self.assertTrue(roots[0].is_point())
        self.assertEqual(roots[0].lo.val, 0)

    def test_tiny_fraction_root(self):
        tiny = Fraction(1, 10 ** 18)
        f = self.dag.sub(self.x, self.dag.const(tiny))
        cert = isolate(f, self.dag, dom(-1, 1), eps=Fraction(1, 10 ** 30))
        roots = self.unique_intervals(cert)
        self.assertEqual(len(roots), 1)
        self.assertTrue(IntervalUnion(roots).contains_end(End(tiny)))
        self.assertLessEqual(roots[0].hi.val - roots[0].lo.val,
                             Fraction(1, 10 ** 30))

    def test_rational_function_with_pole(self):
        # (x-1)/(x-3): root 1, pole at 3 is a domain hole
        f = self.dag.div(self.dag.sub(self.x, 1), self.dag.sub(self.x, 3))
        cert = isolate(f, self.dag, dom(-10, 10))
        roots = self.unique_intervals(cert)
        self.assertEqual(len(roots), 1)
        self.assertTrue(IntervalUnion(roots).contains_end(End(1)))
        holes = [c for c in cert.claims
                 if c.status == NONE and c.evidence.get("kind") == "hole"]
        self.assertEqual(len(holes), 1)
        self.assertEqual(holes[0].interval.lo.val, 3)

    def test_integer_power_expression(self):
        # x^3 - 2x + 2 has exactly one real root (negative)
        f = self.dag.add(self.dag.sub(self.dag.pow(self.x, 3),
                                      self.dag.mul(self.x, 2)),
                         self.dag.const(2))
        cert = isolate(f, self.dag, dom(-10, 10))
        roots = self.unique_intervals(cert)
        self.assertEqual(len(roots), 1)
        self.assertLess(roots[0].hi.val, 0)

    def test_unbounded_domain_clamped_by_cauchy(self):
        f = self.dag.sub(self.dag.pow(self.x, 2), self.dag.const(4))
        cert = isolate(f, self.dag, IntervalUnion([
            Interval(End.inf(-1), True, End.inf(1), True)]))
        roots = self.unique_intervals(cert)
        joined = IntervalUnion(roots)
        self.assertTrue(joined.contains_end(End(-2)))
        self.assertTrue(joined.contains_end(End(2)))

    def test_budget_exhaustion_keeps_undecided(self):
        f = self.dag.sub(self.dag.pow(self.x, 2), self.dag.const(2))
        cert = Isolator(self.dag, f, "x", dom(-10, 10), budget=3,
                        eps=Fraction(1, 10 ** 12)).isolate()
        self.assertTrue(any(c.status == UNDECIDED for c in cert.claims))
        # nothing dropped: claims still cover the domain, certificate valid
        ok, errors = verify_certificate(cert_to_json(cert))
        self.assertTrue(ok, errors)

    def test_cond_expression_isolation(self):
        # |x|-1 via cond: roots at -1 and 1
        absx = self.dag.cond(self.x, self.x, self.dag.neg(self.x))
        f = self.dag.sub(absx, self.dag.const(1))
        cert = isolate(f, self.dag, dom(-4, 4))
        roots = self.unique_intervals(cert)
        joined = IntervalUnion(roots)
        self.assertTrue(joined.contains_end(End(-1)))
        self.assertTrue(joined.contains_end(End(1)))


if __name__ == "__main__":
    unittest.main()
