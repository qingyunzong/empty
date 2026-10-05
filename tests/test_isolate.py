import unittest
from fractions import Fraction as F

from ridag.intervals import Interval, mkset, PINF
from ridag.expr import Ctx, Env
from ridag.isolate import isolate, NONE, UNIQUE, UNDECIDED
from ridag import certcheck


def S(*ivs):
    return mkset(list(ivs))


def iv(lo, hi, lc=True, hc=True):
    return Interval(F(lo), F(hi), lc, hc)


def setup(f_builder, domain, budget=5000):
    c = Ctx()
    x = c.var("x")
    env = Env(c)
    env.set_var("x", S(domain))
    f = f_builder(c, x)
    outs = isolate(c, env, f, "x", S(domain), budget=budget)
    return c, env, f, outs


def contained(v, outs, label=None):
    for o in outs:
        if label is not None and o.label != label:
            continue
        if o.interval.contains(v):
            return True
    return False


class TestIsolate(unittest.TestCase):
    def test_known_rational_roots(self):
        # (2x - 3)(x + 1)(3x - 2): roots 3/2, -1, 2/3
        def build(c, x):
            return c.mul(c.mul(c.sub(c.mul(c.const(2), x), c.const(3)),
                               c.add(x, c.const(1))),
                         c.sub(c.mul(c.const(3), x), c.const(2)))
        c, env, f, outs = setup(build, iv(-3, 3))
        certcheck.verify(c, f, "x", S(iv(-3, 3)), outs)
        for root in (F(3, 2), F(-1), F(2, 3)):
            self.assertTrue(contained(root, outs, UNIQUE),
                            "root %s not uniquely isolated" % root)
        # every unique output contains exactly one of the roots
        roots = [F(3, 2), F(-1), F(2, 3)]
        for o in outs:
            if o.label == UNIQUE:
                self.assertEqual(sum(o.interval.contains(r) for r in roots),
                                 1)
        self.assertFalse(any(o.label == UNDECIDED for o in outs))

    def test_multiple_root_is_undecided_not_dropped(self):
        def build(c, x):
            return c.powi(c.sub(x, c.const(1)), 2)
        c, env, f, outs = setup(build, iv(0, 2), budget=200)
        certcheck.verify(c, f, "x", S(iv(0, 2)), outs)
        self.assertFalse(any(o.label == UNIQUE for o in outs))
        self.assertTrue(contained(F(1), outs, UNDECIDED))

    def test_dependency_overestimation_still_isolates(self):
        # f = x*(x-1) - x*x + 1 == 1 - x, root at 1; naive interval eval
        # over-estimates badly due to cancellation.
        def build(c, x):
            return c.add(c.sub(c.mul(x, c.sub(x, c.const(1))),
                               c.mul(x, x)), c.const(1))
        c = Ctx()
        x = c.var("x")
        env = Env(c)
        env.set_var("x", S(iv(0, 2)))
        f = build(c, x)
        v, _ = env.eval(f)
        self.assertTrue(v[0].lo <= F(-5))  # over-estimation happened
        outs = isolate(c, env, f, "x", S(iv(0, 2)), budget=5000)
        certcheck.verify(c, f, "x", S(iv(0, 2)), outs)
        self.assertTrue(contained(F(1), outs, UNIQUE))
        # dependency over-estimation may leave tiny undecided slivers,
        # but they must shrink under budget (never silently dropped)
        for o in outs:
            if o.label == UNDECIDED:
                self.assertTrue(o.interval.width() < F(1, 16))

    def test_root_near_open_endpoint(self):
        # f = x on the open-at-0 domain (0, 1]: no root.
        def build(c, x):
            return x
        c, env, f, outs = setup(build, iv(0, 1, False, True))
        self.assertEqual(len(outs), 1)
        self.assertEqual(outs[0].label, NONE)
        certcheck.verify(c, f, "x", S(iv(0, 1, False, True)), outs)
        # root 1/10^6, very close to the open endpoint 0
        def build2(c, x):
            return c.sub(x, c.const(F(1, 10 ** 6)))
        c, env, f, outs = setup(build2, iv(0, 1, False, True))
        certcheck.verify(c, f, "x", S(iv(0, 1, False, True)), outs)
        self.assertTrue(contained(F(1, 10 ** 6), outs, UNIQUE))
        for o in outs:
            if o.label == UNIQUE:
                self.assertFalse(o.interval.contains(F(0)))

    def test_tiny_fraction_root(self):
        big = 10 ** 9 + 7
        def build(c, x):
            return c.sub(c.mul(c.const(big), x), c.const(1))
        c, env, f, outs = setup(build, iv(0, 1))
        certcheck.verify(c, f, "x", S(iv(0, 1)), outs)
        self.assertTrue(contained(F(1, big), outs, UNIQUE))

    def test_domain_hole_is_not_a_root(self):
        # f = (x^2 - 1)/(x - 1): root at -1, hole at 1.
        def build(c, x):
            return c.div(c.sub(c.powi(x, 2), c.const(1)),
                         c.sub(x, c.const(1)))
        c, env, f, outs = setup(build, iv(-2, 2), budget=500)
        certcheck.verify(c, f, "x", S(iv(-2, 2)), outs)
        self.assertTrue(contained(F(-1), outs, UNIQUE))
        self.assertFalse(contained(F(1), outs, UNIQUE))
        self.assertFalse(contained(F(1), outs, NONE))
        self.assertTrue(contained(F(1), outs, UNDECIDED))

    def test_reciprocal_no_root_despite_hole(self):
        # f = 1/(x - 1) on [0, 2]: division splits into rays that exclude
        # 0, so the whole domain is certified root-free in one step.
        def build(c, x):
            return c.div(c.const(1), c.sub(x, c.const(1)))
        c, env, f, outs = setup(build, iv(0, 2))
        self.assertEqual(len(outs), 1)
        self.assertEqual(outs[0].label, NONE)
        certcheck.verify(c, f, "x", S(iv(0, 2)), outs)

    def test_budget_exhaustion_keeps_undecided(self):
        def build(c, x):
            return c.sub(c.powi(x, 3), x)  # x^3 - x, derivative straddles 0
        c, env, f, outs = setup(build, iv(-1, 1), budget=1)
        # budget ran out: unresolved parts are kept as undecided
        self.assertTrue(any(o.label == UNDECIDED for o in outs))
        self.assertFalse(any(o.label == NONE for o in outs))
        for v in (F(-1), F(-1, 2), F(0), F(1, 2), F(1)):
            self.assertTrue(contained(v, outs),
                            "undecided outputs dropped coverage at %s" % v)

    def test_unbounded_domain(self):
        def build(c, x):
            return c.sub(x, c.const(5))
        c, env, f, outs = setup(build, Interval(F(0), PINF))
        certcheck.verify(c, f, "x", S(Interval(F(0), PINF)), outs)
        self.assertTrue(contained(F(5), outs, UNIQUE))


if __name__ == "__main__":
    unittest.main()
