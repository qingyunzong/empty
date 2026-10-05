import unittest
from fractions import Fraction as F

from ridag.intervals import Interval, mkset
from ridag.expr import Ctx, Env, derive


def S(*ivs):
    return mkset(list(ivs))


def iv(lo, hi, lc=True, hc=True):
    return Interval(F(lo), F(hi), lc, hc)


class TestDag(unittest.TestCase):
    def test_hash_consing_shares_subexpressions(self):
        c = Ctx()
        x = c.var("x")
        a = c.add(x, c.const(1))
        b = c.add(x, c.const(1))
        self.assertIs(a, b)
        f1 = c.mul(a, a)
        self.assertIs(f1.a, f1.b)
        self.assertIs(c.const(F(1, 2)), c.const(F(2, 4)))

    def test_eval_basic(self):
        c = Ctx()
        x = c.var("x")
        env = Env(c)
        env.set_var("x", S(iv(0, 2)))
        f = c.add(c.mul(x, x), c.const(1))
        v, hole = env.eval(f)
        self.assertEqual(v, S(iv(1, 5)))
        self.assertFalse(hole)

    def test_cache_invalidated_only_by_dependency(self):
        c = Ctx()
        x, y = c.var("x"), c.var("y")
        env = Env(c)
        env.set_var("x", S(iv(0, 1)))
        env.set_var("y", S(iv(5, 5)))
        nx = c.add(x, c.const(1))
        ny = c.add(y, c.const(1))
        env.eval(nx)
        ry1 = env.eval(ny)
        env.set_var("x", S(iv(0, F(1, 2))))  # shrink x only
        ry2 = env.eval(ny)
        self.assertIs(ry1, ry2)  # y-only node still cached
        rx, _ = env.eval(nx)
        self.assertEqual(rx, S(iv(1, F(3, 2))))  # x node recomputed

    def test_rollback_invalidates(self):
        c = Ctx()
        x = c.var("x")
        env = Env(c)
        env.set_var("x", S(iv(0, 4)))
        f = c.mul(x, c.const(2))
        v1, _ = env.eval(f)
        self.assertEqual(v1, S(iv(0, 8)))
        tok = env.save()
        env.set_var("x", S(iv(0, 1)))
        v2, _ = env.eval(f)
        self.assertEqual(v2, S(iv(0, 2)))
        n_recompute = env.stats["recompute"]
        env.restore(tok)
        v3, _ = env.eval(f)
        self.assertEqual(v3, S(iv(0, 8)))
        self.assertGreater(env.stats["recompute"], n_recompute)

    def test_conditional_branch(self):
        c = Ctx()
        x = c.var("x")
        env = Env(c)
        f = c.if_(c.sub(x, c.const(1)), c.mul(x, x), c.sub(c.const(0), x))
        env.set_var("x", S(iv(2, 3)))
        self.assertEqual(env.eval(f)[0], S(iv(4, 9)))
        env.set_var("x", S(iv(-2, -1)))
        self.assertEqual(env.eval(f)[0], S(iv(1, 2)))
        env.set_var("x", S(iv(0, 2)))
        self.assertEqual(env.eval(f)[0], S(iv(-2, 4)))

    def test_symbolic_derivative(self):
        c = Ctx()
        x = c.var("x")
        env = Env(c)
        f = c.sub(c.powi(x, 3), c.mul(c.const(2), x))  # x^3 - 2x
        df = derive(c, f, "x")
        env.set_var("x", S(iv(2, 2)))
        v, _ = env.eval(df)
        self.assertEqual(v, S(iv(10, 10)))  # 3*4 - 2

    def test_derivative_of_quotient(self):
        c = Ctx()
        x = c.var("x")
        env = Env(c)
        f = c.div(c.const(1), x)  # f' = -1/x^2
        df = derive(c, f, "x")
        env.set_var("x", S(iv(2, 2)))
        v, _ = env.eval(df)
        self.assertEqual(v, S(iv(F(-1, 4), F(-1, 4))))


if __name__ == "__main__":
    unittest.main()
