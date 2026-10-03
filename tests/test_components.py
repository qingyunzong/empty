"""Component factorization: merge, re-split, and constraint revocation."""

import unittest

from schcount import Constraint, Problem, Solver

from helpers import brute_force


def two_component_problem():
    p = Problem()
    for v in ("a", "b", "c", "d"):
        p.add_variable(v, [0, 1, 2])
    p.add_constraint(Constraint("c_ab", ("a", "b"), [(0, 1), (1, 2), (2, 0)]))
    p.add_constraint(Constraint("c_cd", ("c", "d"), [(0, 0), (1, 1)]))
    return p


class TestComponents(unittest.TestCase):
    def test_independent_components_multiply(self):
        p = two_component_problem()
        solver = Solver(p)
        result = solver.solve()
        self.assertEqual(result["exact"], 3 * 2)
        self.assertEqual(result["exact"], brute_force(p))
        self.assertGreaterEqual(solver.stats["component_splits"], 1)

    def test_merge_and_resplit(self):
        p = two_component_problem()
        solver = Solver(p)
        split_count = solver.solve()["exact"]
        self.assertEqual(split_count, 6)
        splits_before = solver.stats["component_splits"]

        p.add_constraint(Constraint("c_bc", ("b", "c"), [(0, 0), (1, 1), (2, 1)]))
        merged = solver.solve()
        self.assertTrue(merged["complete"])
        self.assertEqual(merged["exact"], brute_force(p))
        self.assertLess(merged["exact"], split_count)

        p.remove_constraint("c_bc")
        resplit = solver.solve()
        self.assertTrue(resplit["complete"])
        self.assertEqual(resplit["exact"], split_count)
        self.assertGreater(resplit["exact"], merged["exact"])
        self.assertGreater(solver.stats["component_splits"], splits_before)

    def test_revocation_increases_count(self):
        p = Problem()
        p.add_variable("x", [0, 1, 2])
        p.add_variable("y", [0, 1, 2])
        p.add_constraint(Constraint("eq", ("x", "y"), [(0, 0), (1, 1), (2, 2)]))
        solver = Solver(p)
        constrained = solver.solve()["exact"]
        self.assertEqual(constrained, 3)
        p.remove_constraint("eq")
        relaxed = solver.solve()
        self.assertTrue(relaxed["complete"])
        self.assertEqual(relaxed["exact"], 9)
        self.assertGreater(relaxed["exact"], constrained)

    def test_addition_decreases_count(self):
        p = Problem()
        p.add_variable("x", [0, 1, 2])
        p.add_variable("y", [0, 1, 2])
        solver = Solver(p)
        free = solver.solve()["exact"]
        self.assertEqual(free, 9)
        p.add_constraint(Constraint("eq", ("x", "y"), [(0, 0), (1, 1), (2, 2)]))
        constrained = solver.solve()
        self.assertTrue(constrained["complete"])
        self.assertEqual(constrained["exact"], 3)
        self.assertLess(constrained["exact"], free)


if __name__ == "__main__":
    unittest.main()
