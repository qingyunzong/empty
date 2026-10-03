import unittest
from fractions import Fraction

from ridag.dag import DAG
from ridag.evaluator import Evaluator
from ridag.interval import End, Interval, IntervalUnion


def box(lo, hi, lo_open=False, hi_open=False):
    return IntervalUnion([Interval(End(lo), lo_open, End(hi), hi_open)])


class TestEvaluator(unittest.TestCase):
    def setUp(self):
        self.dag = DAG()
        self.x = self.dag.var("x")
        self.ev = Evaluator(self.dag)

    def test_basic_eval(self):
        f = self.dag.add(self.dag.pow(self.x, 2), self.dag.const(1))
        self.ev.set("x", box(Fraction(-1), Fraction(2)))
        r = self.ev.eval(f)
        self.assertEqual(r.value.as_interval().lo.val, 1)
        self.assertEqual(r.value.as_interval().hi.val, 5)

    def test_cache_hit_and_dependency_invalidation(self):
        f = self.dag.add(self.x, self.dag.const(1))
        self.ev.set("x", box(0, 10))
        r1 = self.ev.eval(f)
        self.assertEqual(r1.value.as_interval().hi.val, 11)
        # shrink the variable interval: cache must be invalidated
        self.ev.set("x", box(0, 1))
        r2 = self.ev.eval(f)
        self.assertEqual(r2.value.as_interval().hi.val, 2)
        # rollback to the original interval: cache must be invalidated again
        token = self.ev.snapshot()
        self.ev.set("x", box(5, 6))
        self.assertEqual(self.ev.eval(f).value.as_interval().lo.val, 6)
        self.ev.restore(token)
        self.assertEqual(self.ev.eval(f).value.as_interval().hi.val, 2)

    def test_invalidation_is_per_variable(self):
        y = self.dag.var("y")
        f = self.dag.add(self.x, y)
        self.ev.set("x", box(0, 1))
        self.ev.set("y", box(0, 1))
        f_val = self.ev.eval(f)
        self.assertEqual(f_val.value.as_interval().hi.val, 2)
        # change only x: cached y-part must survive (dependency-tracked)
        self.ev.set("x", box(0, 5))
        self.assertEqual(self.ev.eval(f).value.as_interval().hi.val, 6)

    def test_cond_branches(self):
        f = self.dag.cond(self.x, self.dag.const(1), self.dag.const(-1))
        self.ev.set("x", box(1, 2))
        self.assertEqual(self.ev.eval(f).value.as_interval().lo.val, 1)
        self.ev.set("x", box(-2, -1))
        self.assertEqual(self.ev.eval(f).value.as_interval().lo.val, -1)
        # straddling: union of both branches
        self.ev.set("x", box(-1, 1))
        v = self.ev.eval(f).value
        self.assertEqual(len(v.intervals), 2)

    def test_open_denominator_reported(self):
        f = self.dag.div(self.dag.const(1), self.x)
        self.ev.set("x", box(-1, 1))
        r = self.ev.eval(f)
        self.assertTrue(r.open_denoms)
        self.ev.set("x", box(1, 2))
        r2 = self.ev.eval(f)
        self.assertFalse(r2.open_denoms)

    def test_point_eval_exact(self):
        f = self.dag.div(self.dag.const(1), self.dag.const(3))
        self.assertEqual(self.ev.point_eval(f, "x", Fraction(0)), Fraction(1, 3))

    def test_unbound_variable_raises(self):
        with self.assertRaises(KeyError):
            self.ev.eval(self.x)


if __name__ == "__main__":
    unittest.main()
