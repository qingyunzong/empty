import unittest
from fractions import Fraction as F

from ridag.intervals import Interval, mkset
from ridag.expr import Ctx, Env


def S(*ivs):
    return mkset(list(ivs))


def iv(lo, hi, lc=True, hc=True):
    return Interval(F(lo), F(hi), lc, hc)


class TestSaveRestore(unittest.TestCase):
    def test_nested_save_restore(self):
        c = Ctx()
        x, y = c.var("x"), c.var("y")
        env = Env(c)
        env.set_var("x", S(iv(0, 4)))
        env.set_var("y", S(iv(10, 10)))
        f = c.add(c.mul(x, x), y)
        v0, _ = env.eval(f)
        self.assertEqual(v0, S(iv(10, 26)))

        t1 = env.save()
        env.set_var("x", S(iv(0, 2)))
        v1, _ = env.eval(f)
        self.assertEqual(v1, S(iv(10, 14)))

        t2 = env.save()
        env.set_var("x", S(iv(1, 1)))
        env.set_var("y", S(iv(0, 0)))
        v2, _ = env.eval(f)
        self.assertEqual(v2, S(iv(1, 1)))

        env.restore(t2)
        v3, _ = env.eval(f)
        self.assertEqual(v3, S(iv(10, 14)))

        env.restore(t1)
        v4, _ = env.eval(f)
        self.assertEqual(v4, S(iv(10, 26)))

    def test_restore_forces_recompute(self):
        c = Ctx()
        x = c.var("x")
        env = Env(c)
        env.set_var("x", S(iv(0, 4)))
        f = c.mul(x, c.const(3))
        env.eval(f)
        tok = env.save()
        env.set_var("x", S(iv(0, 1)))
        env.eval(f)
        n = env.stats["recompute"]
        env.restore(tok)
        env.eval(f)
        self.assertGreater(env.stats["recompute"], n)

    def test_shrink_then_eval_at_restores(self):
        c = Ctx()
        x = c.var("x")
        env = Env(c)
        env.set_var("x", S(iv(0, 10)))
        f = c.add(x, c.const(1))
        v, _ = env.eval_at(f, "x", S(iv(2, 3)))
        self.assertEqual(v, S(iv(3, 4)))
        # outer binding untouched
        v2, _ = env.eval(f)
        self.assertEqual(v2, S(iv(1, 11)))


if __name__ == "__main__":
    unittest.main()
