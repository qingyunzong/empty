import unittest
from fractions import Fraction

from ridag.dag import DAG


class TestDAG(unittest.TestCase):
    def setUp(self):
        self.dag = DAG()
        self.x = self.dag.var("x")

    def test_hash_consing_shares_nodes(self):
        a = self.dag.add(self.x, self.dag.const(1))
        b = self.dag.add(self.x, self.dag.const(1))
        self.assertIs(a, b)
        self.assertEqual(len(self.dag.nodes), 3)

    def test_cancellation_exact(self):
        f = self.dag.sub(self.x, self.x)
        self.assertEqual(f.op, "const")
        self.assertEqual(f.args[0], 0)

    def test_identity_simplifications(self):
        one = self.dag.const(1)
        zero = self.dag.const(0)
        self.assertIs(self.dag.mul(one, self.x), self.x)
        self.assertIs(self.dag.mul(zero, self.x), zero)
        self.assertIs(self.dag.add(self.x, zero), self.x)
        self.assertEqual(self.dag.pow(self.x, 0).args[0], 1)
        self.assertIs(self.dag.pow(self.x, 1), self.x)

    def test_constant_folding(self):
        f = self.dag.add(self.dag.const(Fraction(1, 3)),
                         self.dag.const(Fraction(1, 6)))
        self.assertEqual(f.args[0], Fraction(1, 2))

    def test_diff_polynomial(self):
        # f = x^2 - 2 -> f' = 2x
        f = self.dag.sub(self.dag.pow(self.x, 2), self.dag.const(2))
        fp = self.dag.diff(f, "x")
        # evaluate f' at 3 -> 6
        from ridag.evaluator import Evaluator
        ev = Evaluator(self.dag)
        self.assertEqual(ev.point_eval(fp, "x", Fraction(3)), Fraction(6))

    def test_diff_quotient(self):
        # f = 1/x -> f' = -1/x^2
        f = self.dag.div(self.dag.const(1), self.x)
        fp = self.dag.diff(f, "x")
        from ridag.evaluator import Evaluator
        ev = Evaluator(self.dag)
        self.assertEqual(ev.point_eval(fp, "x", Fraction(2)), Fraction(-1, 4))

    def test_diff_cond(self):
        # cond(x, x^2, -x) derivative at x=2 is 4 (then branch)
        f = self.dag.cond(self.x, self.dag.pow(self.x, 2), self.dag.neg(self.x))
        fp = self.dag.diff(f, "x")
        from ridag.evaluator import Evaluator
        ev = Evaluator(self.dag)
        self.assertEqual(ev.point_eval(fp, "x", Fraction(2)), Fraction(4))
        self.assertEqual(ev.point_eval(fp, "x", Fraction(-2)), Fraction(-1))

    def test_denominators_collected(self):
        f = self.dag.div(self.x, self.dag.sub(self.x, self.dag.const(1)))
        dens = self.dag.denominators(f)
        self.assertEqual(len(dens), 1)
        self.assertIs(dens[0], f.args[1])

    def test_variables(self):
        y = self.dag.var("y")
        f = self.dag.add(self.x, y)
        self.assertEqual(self.dag.variables(f), {"x", "y"})

    def test_shared_subexpression_single_node(self):
        # (x+1)*(x+1): the shared child must be one object
        a = self.dag.add(self.x, self.dag.const(1))
        f = self.dag.mul(a, a)
        self.assertIs(f.args[0], f.args[1])


if __name__ == "__main__":
    unittest.main()
